import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fetchPreviousFromDrive } from './lib/drive-fetch.js';
import { loginPaynixMerchant, getAuthenticatedContext } from './lib/paynix-merchant-login.js';
import { getSuspendedMerchantIds } from './lib/suspended-merchants.js';

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
const MERCHANT_DASHBOARD_URL = 'https://merchant.paynix.co.in/dashboard';
const SESSIONS_DIR = path.join('./data', 'paynix-sessions');
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');
// Own dedicated file, separate from website/paynix-results.json (the
// reseller/failed-payout scrape owned exclusively by download-paynix.js).
// Was previously merged into that shared file — but since wallet-alert.yml
// and refresh.yml can now run concurrently (separate concurrency groups),
// a shared file meant a read-modify-write race: whichever workflow's
// Drive upload landed second could clobber the other's fresher data with
// a stale copy it had fetched before the other's write. Confirmed
// 2026-08-07: this caused refresh.yml's failed-payout diffing to keep
// losing newly-detected failures to wallet-alert.yml's stale re-uploads,
// so the same failed transaction got alerted 3 times in a row. Splitting
// into two files each workflow exclusively owns eliminates the race
// entirely — there's no shared file left to clobber.
const OUTPUT_JSON = path.join('./website', 'paynix-wallet-log-results.json');
const SNAPSHOT_FILE = path.join('./data', 'paynix-wallet-log-snapshot.json');
const TOP_N = 5;

const { PAYNIX_HEADFUL, GOOGLE_DRIVE_PAYNIX_WALLETLOG_FILE_ID, GOOGLE_DRIVE_PAYNIX_FILE_ID, GOOGLE_DRIVE_API_KEY } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

function parseINR(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[₹,\s−–-]/g, (m) => (m === '−' || m === '–' || m === '-' ? '-' : ''));
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

// Assumes the page's context is already authenticated (see
// getAuthenticatedContext in run() below, which handles login + session
// reuse before calling this).
async function scrapeWalletLog(page) {
  await page.goto('https://merchant.paynix.co.in/dashboard/wallet', { waitUntil: 'domcontentloaded' });

  // The page has two tables — "Load Requests" (wallet top-ups: REQUEST ID,
  // AMOUNT, METHOD, UTR, STATUS, CREATED) and "Transaction History" (full
  // debit/credit ledger). Wallet-log entries here track top-up requests —
  // both pending and approved show up here, not filtered by status — so
  // target the Load Requests table specifically by its header text.
  const table = page.locator('table').filter({ hasText: 'REQUEST ID' });
  // Wait for the table itself to render (was: a blind fixed 2s delay,
  // which raced the table's client-side data fetch on slower loads and
  // intermittently read 0 rows from a still-empty table — confirmed
  // 2026-08-08 as the cause of repeated false "new" wallet-top-up alerts
  // for Emervex, whose real entries kept getting wiped from the baseline
  // by these empty reads). Not a full fix by itself (a merchant with
  // genuinely zero load requests still legitimately reads 0 rows here) —
  // paired with the previous-baseline fallback in run() below.
  await table.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const rows = table.first().locator('tbody tr');
  // Re-check once more before trusting a 0-row read, same pattern as
  // download-paynix.js's failed-payout scraper — added 2026-08-13 after
  // VIJAJ TRADERS PRIVATE LIMITED hit this exact render-timing miss 3
  // times in one day (confirmed for real via a direct API check each
  // time: the entries genuinely existed, the DOM table just hadn't
  // finished rendering yet on the first read). The run()-level
  // preserve-previous-baseline fallback below still catches a genuine
  // 0-row merchant or a miss on both reads — this just cuts how often
  // that fallback (which means a same-run miss, not just a delayed
  // detection on some later run) has to fire at all.
  let count = await rows.count();
  if (count === 0) {
    await page.waitForTimeout(2000);
    count = await rows.count();
  }
  const entries = [];

  for (let i = 0; i < Math.min(count, TOP_N); i++) {
    const cells = await rows.nth(i).locator('td').evaluateAll((tds) => tds.map((td) => td.innerText.trim()));
    if (cells.length < 6) continue;
    entries.push({
      requestId: cells[0] || null,
      amount: parseINR(cells[1]),
      method: cells[2] || null,
      utr: cells[3] || null,
      status: cells[4] || null,
      createdAt: cells[5] || null,
    });
  }
  return entries;
}

// No previous entries for this merchant (first time it's been scraped, e.g.
// a merchant just added to the reseller network) -> nothing is "new", it's
// just the starting snapshot. Otherwise: any requestId not seen last run,
// OR a previously-seen requestId whose status changed (e.g. Pending ->
// Approved) — added 2026-08-07 per explicit request so a top-up alert
// isn't just "one and done" at first sight, status transitions matter too.
function computeNewOrChangedLoadRequests(previousEntries, currentEntries) {
  if (!previousEntries) return [];
  const prevById = new Map(previousEntries.map((e) => [e.requestId, e]));
  const changed = [];
  for (const e of currentEntries) {
    if (!e.requestId) continue;
    const prev = prevById.get(e.requestId);
    if (!prev) {
      changed.push(e);
    } else if (prev.status !== e.status) {
      changed.push({ ...e, previousStatus: prev.status });
    }
  }
  return changed;
}

async function run() {
  if (!fs.existsSync(LOGINS_FILE)) {
    console.log('No data/paynix-merchant-logins.json found, skipping merchant wallet scrape.');
    return;
  }
  const allLogins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));

  // Suspended accounts can never log in — skip them entirely, no attempt,
  // no failure record, no alert. See lib/suspended-merchants.js.
  const suspendedIds = await getSuspendedMerchantIds(GOOGLE_DRIVE_PAYNIX_FILE_ID, GOOGLE_DRIVE_API_KEY);
  const suspendedLogins = allLogins.filter((l) => suspendedIds.has(l.merchantId));
  const logins = allLogins.filter((l) => !suspendedIds.has(l.merchantId));
  if (suspendedLogins.length) {
    console.log(`Skipping ${suspendedLogins.length} suspended merchant(s): ${suspendedLogins.map((l) => l.merchantName).join(', ')}`);
  }

  const previousResults = await fetchPreviousFromDrive(GOOGLE_DRIVE_PAYNIX_WALLETLOG_FILE_ID, GOOGLE_DRIVE_API_KEY);
  const previousWalletLogs = previousResults?.walletLogs || {};

  const walletLogs = {};
  const newLoadRequests = {};

  const browser = await chromium.launch({ headless });
  for (const login of logins) {
    // Paynix's dashboard renders the "Created" column client-side using
    // the browser's local timezone. GitHub Actions runners default to
    // UTC, which silently shifted every scraped wallet-log timestamp
    // 5.5 hours earlier than the real IST time (only matched reality when
    // run locally on an IST machine — confirmed 2026-07-15 by comparing
    // the DOM-scraped text against the raw UTC created_at from Paynix's
    // own /wallet/load-requests API). Pin the timezone explicitly so
    // scrapes are correct regardless of runner OS timezone.
    // Declared outside the try so the finally block can close it — but
    // creation itself (including performLogin, which can throw on a login
    // failure) now happens *inside* the try, so one merchant's login
    // failure falls through to the same preserve-previous-baseline catch
    // below instead of crashing the whole run (a regression introduced and
    // caught while wiring this up: getAuthenticatedContext used to be
    // called before the try/catch, so an OTP/login failure for any single
    // merchant took down the entire script instead of just skipping them).
    let context;
    try {
      const sessionFile = path.join(SESSIONS_DIR, `${login.merchantId}.json`);
      const authed = await getAuthenticatedContext(browser, {
        sessionFile,
        dashboardUrl: MERCHANT_DASHBOARD_URL,
        contextOptions: { timezoneId: 'Asia/Kolkata' },
        performLogin: (p) => loginPaynixMerchant(p, MERCHANT_LOGIN_URL, login.username, login.password),
        merchantLabel: login.merchantName,
      });
      if (authed.skipped) {
        // Backing off after a recent login failure — preserve last-known
        // data without attempting anything (no context/page exist here).
        walletLogs[login.merchantId] = previousWalletLogs[login.merchantId] || [];
        newLoadRequests[login.merchantId] = [];
        continue;
      }
      context = authed.context;
      const page = authed.page;
      console.log(`Scraping wallet log for ${login.merchantName}${authed.reused ? ' (reused session)' : ' (fresh login)'}...`);
      const entries = await scrapeWalletLog(page);
      const prevEntries = previousWalletLogs[login.merchantId];
      if (entries.length === 0 && prevEntries?.length > 0) {
        // A 0-row read when the previous run had real entries is far more
        // likely a table-not-finished-rendering timing issue than the
        // merchant's load requests genuinely vanishing (Paynix doesn't
        // delete them). Confirmed 2026-08-08: Emervex flapped between its
        // real 2 entries and [] across runs, re-alerting the same July
        // top-ups as "new" every time the empty read got treated as the
        // real baseline. Keep the previous entries and don't alert,
        // mirroring the existing preserve-on-failure pattern below.
        console.warn(`  0 rows scraped for ${login.merchantName} but previous run had ${prevEntries.length} — likely a render-timing hiccup, keeping previous baseline instead of overwriting with empty.`);
        walletLogs[login.merchantId] = prevEntries;
        newLoadRequests[login.merchantId] = [];
      } else {
        // Partial-read guard, added 2026-08-11 after VELCYNTRA's
        // LR_22C9D8FCDC74 (₹3,00,000) silently dropped off two
        // consecutive CI scrapes in a row despite the DOM table reading
        // correctly and consistently (5/5 attempts) when checked
        // manually moments later — a CI-environment-only partial read
        // (1 of 2 rows) that the 0-row guard above doesn't catch, since
        // it only fires on a *total* empty read. Load requests are
        // never deleted on Paynix's side (see comment on
        // computeNewOrChangedLoadRequests), so any previously-seen
        // requestId missing from this run's read is scrape loss, not a
        // real disappearance — merge it back in rather than silently
        // dropping it and re-alerting it as "new" on some later run
        // that happens to catch it again.
        const entryIds = new Set(entries.map((e) => e.requestId));
        const recovered = (prevEntries || []).filter((e) => e.requestId && !entryIds.has(e.requestId));
        if (recovered.length > 0) {
          console.warn(`  ${recovered.length} previously-seen load request(s) for ${login.merchantName} missing from this scrape (${recovered.map((e) => e.requestId).join(', ')}) — merging back in as a partial-read guard.`);
        }
        walletLogs[login.merchantId] = [...entries, ...recovered];
        const changed = computeNewOrChangedLoadRequests(prevEntries, entries);
        // Embed merchantName directly on each alert-worthy entry so
        // telegram-alert.js doesn't need to cross-reference the separate
        // reseller-scrape file (which it no longer has access to — that
        // file is now exclusively refresh.yml's).
        newLoadRequests[login.merchantId] = changed.map((e) => ({ ...e, merchantName: login.merchantName }));
      }
    } catch (err) {
      console.warn(`Failed to scrape ${login.merchantName}: ${err.message}`);
      // Preserve the last-known-good entries instead of wiping this
      // merchant's baseline to []. An empty array was getting uploaded to
      // Drive as the new "previous" state on every transient scrape
      // failure, so the next successful scrape compared against nothing
      // and re-alerted every entry as brand new — including ones already
      // alerted in an earlier cron run (confirmed 2026-08-07).
      walletLogs[login.merchantId] = previousWalletLogs[login.merchantId] || [];
      newLoadRequests[login.merchantId] = [];
    } finally {
      if (context) await context.close();
    }
  }
  await browser.close();

  const results = { walletLogs, newLoadRequests, walletLogsGeneratedAt: new Date().toISOString() };

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(results, null, 2));

  const totalNew = Object.values(newLoadRequests).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`\nWallet logs captured for ${Object.keys(walletLogs).length} merchant(s), top ${TOP_N} entries each.`);
  console.log(`${totalNew} new load request(s) since last check.`);
}

run().catch((err) => {
  console.error('Paynix merchant wallet scrape failed:', err);
  process.exit(1);
});
