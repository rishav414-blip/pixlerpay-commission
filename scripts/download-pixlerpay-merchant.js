import 'dotenv/config';
import { chromium } from 'playwright';
import xlsx from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { fetchPreviousFromDrive } from './lib/drive-fetch.js';

const {
  PIXLERPAY_MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login',
  PIXLERPAY_MERCHANT_USERNAME,
  PIXLERPAY_MERCHANT_PASSWORD,
  PAYNIX_HEADFUL,
  GOOGLE_DRIVE_PIXLERPAY_MERCHANT_FILE_ID,
  GOOGLE_DRIVE_API_KEY,
} = process.env;

if (!PIXLERPAY_MERCHANT_USERNAME || !PIXLERPAY_MERCHANT_PASSWORD) {
  console.error('Missing PIXLERPAY_MERCHANT_USERNAME / PIXLERPAY_MERCHANT_PASSWORD in .env.');
  process.exit(1);
}

const DATA_DIR = './data';
const SNAPSHOT_FILE = path.join(DATA_DIR, 'pixlerpay-merchant-snapshot.json');
const OUTPUT_JSON = path.join('./website', 'pixlerpay-merchant-results.json');
const TOP_N_WALLET_LOG = 5;
const RETENTION_DAYS = 30;
const FETCH_WINDOW_DAYS = Number(process.env.PIXLERPAY_MERCHANT_FETCH_WINDOW_DAYS) || 3;

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// PixlerPay merchant export dates look like "9/7/2026, 12:37:47 pm" (D/M/YYYY).
function parseToISODate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  return null;
}

const headless = PAYNIX_HEADFUL !== 'true';

// Commission rule (per user instruction): 0.05% of amount for payouts above
// ₹1000, flat ₹1 for payouts at or below ₹1000. Applies to SUCCESS payouts only.
function calcCommission(amount) {
  return amount > 1000 ? Math.round(amount * 0.0005 * 100) / 100 : 1;
}

function parseINR(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[₹,\s−–]/g, (m) => (m === '−' || m === '–' ? '-' : ''));
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

async function scrapeWalletBalance(page) {
  await page.goto('https://merchant.paynix.co.in/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const text = await page.locator('body').innerText();
  const m = text.match(/WALLET BALANCE\s*\n+\s*(₹[\d,.]+)/);
  return m ? parseINR(m[1]) : null;
}

async function scrapeWalletLog(page) {
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

  for (let i = 0; i < Math.min(count, TOP_N_WALLET_LOG); i++) {
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

// No previous entries (first-ever run) -> nothing is "new", it's just the
// starting snapshot.
function computeNewLoadRequests(previousEntries, currentEntries) {
  if (!previousEntries) return [];
  const prevIds = new Set(previousEntries.map((e) => e.requestId));
  return currentEntries.filter((e) => e.requestId && !prevIds.has(e.requestId));
}

// Incremental fetch (2026-07-14): this used to export the FULL lifetime
// payout history every run (700+ rows and growing). Now applies the
// portal's own date filter (same UI confirmed working on the individual
// merchant accounts in download-paynix-merchant-reports.js) before
// exporting, so only a recent window is downloaded — run() below merges
// it against the previously published snapshot (deduped by payoutId) and
// prunes anything older than 30 days.
async function exportPayouts(page, fromDate, toDate) {
  await page.goto('https://merchant.paynix.co.in/dashboard/payouts', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const dateInputs = page.locator('input[type="date"]');
  if (await dateInputs.count() >= 2) {
    await dateInputs.nth(0).fill(fromDate);
    await dateInputs.nth(1).fill(toDate);
    const applyBtn = page.getByRole('button', { name: /apply/i }).first();
    if (await applyBtn.count()) {
      await applyBtn.click();
      await page.waitForTimeout(1500);
    }
  }

  const exportBtn = page.getByRole('button', { name: /export/i }).first();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    exportBtn.click(),
  ]);

  const tmpPath = path.join(DATA_DIR, '_pixlerpay-payouts-export.xlsx');
  await download.saveAs(tmpPath);

  const wb = xlsx.readFile(tmpPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });
  fs.unlinkSync(tmpPath);

  return rows.map((r) => {
    const amount = Number(r['Amount (₹)']) || 0;
    const status = r['Status'] || null;
    return {
      payoutId: r['Transaction ID'] || null,
      referenceId: r['Reference ID'] || null,
      status,
      amount,
      fee: Number(r['Fee (₹)']) || 0,
      gst: Number(r['GST (₹)']) || 0,
      totalDebit: Number(r['Total Debit (₹)']) || 0,
      beneficiaryName: r['Beneficiary Name'] || null,
      accountLast4: r['Account Last 4'] || null,
      ifsc: r['IFSC'] || null,
      utr: r['UTR'] || null,
      transferMode: r['Transfer Mode'] || null,
      gateway: r['Gateway'] || null,
      gatewayReqId: r['Gateway Req ID'] || null,
      narration: r['Narration'] || null,
      failureReason: r['Failure Reason'] || null,
      createdAt: r['Created At (IST)'] || null,
      completedAt: r['Completed At (IST)'] || null,
      commission: status === 'SUCCESS' ? calcCommission(amount) : 0,
    };
  });
}

async function run() {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  console.log('Logging into PixlerPay Paynix merchant account...');
  await page.goto(PIXLERPAY_MERCHANT_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Email address' }).fill(PIXLERPAY_MERCHANT_USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).fill(PIXLERPAY_MERCHANT_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForTimeout(3000);

  console.log('Scraping wallet balance...');
  const walletBalance = await scrapeWalletBalance(page);

  console.log(`Scraping wallet transaction log (top ${TOP_N_WALLET_LOG})...`);
  const walletLog = await scrapeWalletLog(page);

  const fromDate = isoDaysAgo(FETCH_WINDOW_DAYS);
  const toDate = isoDaysAgo(0);
  console.log(`Exporting payouts (xlsx download, ${fromDate} to ${toDate})...`);
  const freshPayouts = await exportPayouts(page, fromDate, toDate);

  await browser.close();

  const previousResults = await fetchPreviousFromDrive(GOOGLE_DRIVE_PIXLERPAY_MERCHANT_FILE_ID, GOOGLE_DRIVE_API_KEY);
  const newLoadRequests = computeNewLoadRequests(previousResults?.walletLog, walletLog);

  // Merge the fresh window against the previous snapshot (deduped by
  // payoutId, same pattern as calculate-commission.js /
  // calculate-paynix-commission.js), then prune anything older than
  // RETENTION_DAYS.
  const mergedByPayoutId = new Map();
  for (const p of previousResults?.payouts || []) {
    if (!p.payoutId) continue;
    mergedByPayoutId.set(p.payoutId, p);
  }
  for (const p of freshPayouts) {
    if (!p.payoutId) continue;
    mergedByPayoutId.set(p.payoutId, p);
  }
  const cutoffISO = isoDaysAgo(RETENTION_DAYS);
  const payouts = Array.from(mergedByPayoutId.values()).filter((p) => {
    const isoDate = parseToISODate(p.createdAt);
    return !isoDate || isoDate >= cutoffISO;
  });
  console.log(`Merged payout log: ${mergedByPayoutId.size} total, ${payouts.length} within ${RETENTION_DAYS}-day retention window (cutoff ${cutoffISO}).`);

  const successPayouts = payouts.filter((p) => p.status === 'SUCCESS');
  const totalCommission = Math.round(successPayouts.reduce((sum, p) => sum + p.commission, 0) * 100) / 100;
  const totalSuccessVolume = Math.round(successPayouts.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;

  const snapshot = {
    scrapedAt: new Date().toISOString(),
    walletBalance,
    walletLog,
    newLoadRequests,
    summary: {
      totalPayouts: payouts.length,
      successCount: successPayouts.length,
      failedCount: payouts.filter((p) => p.status === 'FAILED').length,
      totalSuccessVolume,
      totalCommission,
    },
    payouts,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(snapshot, null, 2));

  console.log(`\nSnapshot saved to ${SNAPSHOT_FILE} and ${OUTPUT_JSON}`);
  console.log(`Payouts: ${payouts.length} total, ${successPayouts.length} success, wallet balance Rs ${walletBalance}`);
  console.log(`Total commission (0.05% above Rs1000, flat Rs1 at/below): Rs ${totalCommission}`);
}

run().catch((err) => {
  console.error('PixlerPay merchant scrape failed:', err);
  process.exit(1);
});
