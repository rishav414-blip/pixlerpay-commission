import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');
const OUTPUT_JSON = path.join('./website', 'paynix-results.json');
const SNAPSHOT_FILE = path.join('./data', 'paynix-snapshot.json');
const TOP_N = 3;

const headless = process.env.PAYNIX_HEADFUL !== 'true';

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
  // debit/credit ledger). Wallet-log entries here track top-up requests,
  // so target the Load Requests table specifically by its header text.
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

async function run() {
  if (!fs.existsSync(LOGINS_FILE)) {
    console.log('No data/paynix-merchant-logins.json found, skipping merchant wallet scrape.');
    return;
  }
  const logins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));
  if (!fs.existsSync(OUTPUT_JSON)) {
    console.error(`${OUTPUT_JSON} not found — run download-paynix first.`);
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(OUTPUT_JSON, 'utf-8'));
  const walletLogs = {};

  const browser = await chromium.launch({ headless });
  for (const login of logins) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      console.log(`Scraping wallet log for ${login.merchantName}...`);
      walletLogs[login.merchantId] = await scrapeWalletLog(page, login);
    } catch (err) {
      console.warn(`Failed to scrape ${login.merchantName}: ${err.message}`);
      walletLogs[login.merchantId] = [];
    } finally {
      await context.close();
    }
  }
  await browser.close();

  results.walletLogs = walletLogs;
  results.walletLogsGeneratedAt = new Date().toISOString();

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));
  if (fs.existsSync(SNAPSHOT_FILE)) {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
    snapshot.walletLogs = walletLogs;
    snapshot.walletLogsGeneratedAt = results.walletLogsGeneratedAt;
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  }

  console.log(`\nWallet logs captured for ${Object.keys(walletLogs).length} merchant(s), top ${TOP_N} entries each.`);
}

run().catch((err) => {
  console.error('Paynix merchant wallet scrape failed:', err);
  process.exit(1);
});
