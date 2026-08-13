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

// IST has no DST, so a fixed +5:30 offset is safe — matches the format the
// old DOM-scraped "Created" column produced ("13/08/26, 7:45 pm"), which
// parseWalletTimestamp (lib/wallet-timestamp.js) and every stored baseline
// entry still expect. Keeping this exact format is what let the API switch
// below be a drop-in replacement instead of also needing to touch the
// display/parsing code and re-normalize every already-stored entry.
function formatIST(isoString) {
  const istMs = new Date(isoString).getTime() + (5 * 60 + 30) * 60000;
  const d = new Date(istMs);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  let hh = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ap = hh >= 12 ? 'pm' : 'am';
  hh = hh % 12 || 12;
  return `${dd}/${mo}/${yy}, ${hh}:${mm} ${ap}`;
}

function titleCaseStatus(status) {
  if (!status) return null;
  return status.charAt(0) + status.slice(1).toLowerCase();
}

// Was DOM-table scraping ("Load Requests" table on /dashboard/wallet) —
// switched 2026-08-13 to the same authenticated JSON API pattern already
// used for payouts (download-paynix-merchant-reports.js), after a same-run
// retry (added earlier the same day) still wasn't enough: VIJAJ TRADERS
// PRIVATE LIMITED dropped its newest (₹20,50,000) load request from a live
// CI scrape *again*, post-retry-fix, confirmed by comparing the live
// Drive-uploaded baseline against a direct API check showing the entry
// really existed. DOM-render timing is eliminated entirely this way — the
// API response is the source of truth the DOM table itself was built from.
// Assumes the page's context is already authenticated (see
// getAuthenticatedContext in run() below, which handles login + session
// reuse before calling this) — no navigation needed, the fetch runs
// against api.paynix.co.in from whatever page (still on the dashboard,
// same origin as when the token was issued) the auth flow left us on.
async function scrapeWalletLog(page) {
  // Bug found and fixed same day this API switch shipped: a bare fetch()
  // inside page.evaluate has no default timeout — if a single merchant's
  // request hangs (bad network moment, not an outright error), the whole
  // CI job hangs with it, since Node's own `await page.evaluate(...)`
  // just waits for the browser-side promise to settle, which never
  // happens on its own. Confirmed live: the first production run after
  // this rewrite landed hung for the full 15-minute job timeout instead
  // of the usual ~1-2 min for all merchants combined, and only died
  // because GitHub Actions killed the job, not because anything in this
  // script gave up. AbortController + a 15s cap, mirroring the timeout
  // the old DOM-wait code always had implicitly via Playwright's own
  // waitFor(), gives one merchant's bad network moment the same bounded
  // failure the outer per-merchant try/catch (in run() below) already
  // expects and handles — instead of taking the whole run down with it.
  const result = await page.evaluate(async (perPage) => {
    const token = localStorage.getItem('paynix_access_token');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`https://api.paynix.co.in/api/v1/merchant/portal/wallet/load-requests?page=1&per_page=${perPage}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }, TOP_N);

  if (!result?.success) {
    throw new Error(`wallet/load-requests API error: ${JSON.stringify(result?.error || result)}`);
  }

  const entries = (result.data || []).map((r) => ({
    requestId: r.request_id || null,
    amount: Number(r.amount) || 0,
    method: r.payment_method || null,
    utr: r.utr || null,
    status: titleCaseStatus(r.status),
    createdAt: formatIST(r.created_at),
  }));
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
