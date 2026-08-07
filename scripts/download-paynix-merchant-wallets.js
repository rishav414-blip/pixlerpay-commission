import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fetchPreviousFromDrive } from './lib/drive-fetch.js';

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
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

const { PAYNIX_HEADFUL, GOOGLE_DRIVE_PAYNIX_WALLETLOG_FILE_ID, GOOGLE_DRIVE_API_KEY } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

function parseINR(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[₹,\s−–-]/g, (m) => (m === '−' || m === '–' || m === '-' ? '-' : ''));
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

async function scrapeWalletLog(page, login) {
  await page.goto(MERCHANT_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Email address' }).fill(login.username);
  await page.getByRole('textbox', { name: 'Password' }).fill(login.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForTimeout(3000);

  await page.goto('https://merchant.paynix.co.in/dashboard/wallet', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // The page has two tables — "Load Requests" (wallet top-ups: REQUEST ID,
  // AMOUNT, METHOD, UTR, STATUS, CREATED) and "Transaction History" (full
  // debit/credit ledger). Wallet-log entries here track top-up requests —
  // both pending and approved show up here, not filtered by status — so
  // target the Load Requests table specifically by its header text.
  const table = page.locator('table').filter({ hasText: 'REQUEST ID' }).first();
  const rows = table.locator('tbody tr');
  const count = await rows.count();
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
  const logins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));

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
    const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
    const page = await context.newPage();
    try {
      console.log(`Scraping wallet log for ${login.merchantName}...`);
      const entries = await scrapeWalletLog(page, login);
      walletLogs[login.merchantId] = entries;
      const changed = computeNewOrChangedLoadRequests(previousWalletLogs[login.merchantId], entries);
      // Embed merchantName directly on each alert-worthy entry so
      // telegram-alert.js doesn't need to cross-reference the separate
      // reseller-scrape file (which it no longer has access to — that
      // file is now exclusively refresh.yml's).
      newLoadRequests[login.merchantId] = changed.map((e) => ({ ...e, merchantName: login.merchantName }));
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
      await context.close();
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
