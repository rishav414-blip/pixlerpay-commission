import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fetchPreviousFromDrive } from './lib/drive-fetch.js';

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');
const OUTPUT_JSON = path.join('./website', 'paynix-results.json');
const SNAPSHOT_FILE = path.join('./data', 'paynix-snapshot.json');
const TOP_N = 5;

const { PAYNIX_HEADFUL, GOOGLE_DRIVE_PAYNIX_FILE_ID, GOOGLE_DRIVE_API_KEY } = process.env;
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

  // download-paynix.js's baseline for diffing (walletLogs) has to come
  // from the last *published* snapshot regardless, so fetch it from Drive
  // first either way.
  const previousResults = await fetchPreviousFromDrive(GOOGLE_DRIVE_PAYNIX_FILE_ID, GOOGLE_DRIVE_API_KEY);
  const previousWalletLogs = previousResults?.walletLogs || {};

  // No longer requires download-paynix.js to have run first in the same
  // job (was: hard error if OUTPUT_JSON missing). That coupling meant
  // wallet-alert.yml had to re-run the full reseller scrape (merchants +
  // failed payouts) on every wallet-log check, and — since both workflows
  // then uploaded to the same Drive file — whichever workflow scraped
  // first "consumed" a newly-failed payout by publishing it, leaving
  // nothing "new" for the other workflow's failed-payout alert to find
  // (confirmed 2026-08-07: refresh.yml's failed-payout section was
  // reporting "0 new" because wallet-alert.yml, now running every 5 min,
  // was winning that race almost every time). Falling back to Drive's
  // last full snapshot for merchants/failedPayouts/summary means this
  // script only ever touches walletLogs — refresh.yml is the sole owner
  // of failed-payout detection and its Drive uploads, on its own cadence.
  const results = fs.existsSync(OUTPUT_JSON)
    ? JSON.parse(fs.readFileSync(OUTPUT_JSON, 'utf-8'))
    : (previousResults || {});

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
      newLoadRequests[login.merchantId] = computeNewOrChangedLoadRequests(previousWalletLogs[login.merchantId], entries);
    } catch (err) {
      console.warn(`Failed to scrape ${login.merchantName}: ${err.message}`);
      walletLogs[login.merchantId] = [];
      newLoadRequests[login.merchantId] = [];
    } finally {
      await context.close();
    }
  }
  await browser.close();

  results.walletLogs = walletLogs;
  results.newLoadRequests = newLoadRequests;
  results.walletLogsGeneratedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));
  if (fs.existsSync(SNAPSHOT_FILE)) {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
    snapshot.walletLogs = walletLogs;
    snapshot.newLoadRequests = newLoadRequests;
    snapshot.walletLogsGeneratedAt = results.walletLogsGeneratedAt;
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  }

  const totalNew = Object.values(newLoadRequests).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`\nWallet logs captured for ${Object.keys(walletLogs).length} merchant(s), top ${TOP_N} entries each.`);
  console.log(`${totalNew} new load request(s) since last check.`);
}

run().catch((err) => {
  console.error('Paynix merchant wallet scrape failed:', err);
  process.exit(1);
});
