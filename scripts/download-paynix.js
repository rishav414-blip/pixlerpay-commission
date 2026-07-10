import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const {
  PAYNIX_LOGIN_URL = 'https://reseller.paynix.co.in/auth/login',
  PAYNIX_USERNAME,
  PAYNIX_PASSWORD,
  PAYNIX_HEADFUL,
} = process.env;

if (!PAYNIX_USERNAME || !PAYNIX_PASSWORD) {
  console.error('Missing PAYNIX_USERNAME / PAYNIX_PASSWORD in .env.');
  process.exit(1);
}

const DATA_DIR = './data';
const SNAPSHOT_FILE = path.join(DATA_DIR, 'paynix-snapshot.json');
const PREV_SNAPSHOT_FILE = path.join(DATA_DIR, 'paynix-snapshot-previous.json');
const OUTPUT_JSON = path.join('./website', 'paynix-results.json');

const headless = PAYNIX_HEADFUL !== 'true';

// Parses "₹1,74,963.70" -> 174963.70
function parseINR(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[₹,\s]/g, '');
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

async function rowCells(row) {
  return row.locator('td').evaluateAll((tds) => tds.map((td) => td.innerText.trim()));
}

async function scrapeMerchants(page) {
  await page.goto('https://reseller.paynix.co.in/dashboard/merchants', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const rows = page.locator('table tbody tr');
  const count = await rows.count();
  const merchants = [];

  for (let i = 0; i < count; i++) {
    const cells = await rowCells(rows.nth(i));
    if (cells.length < 4) continue;
    // MERCHANT cell: "RA\nRASHEEYA TECHNOLOGY PRIVATE LIMITED\nMER_1F18C5EDCA3B"
    const merchantLines = cells[0].split('\n').map((s) => s.trim()).filter(Boolean);
    const merchantId = merchantLines.find((l) => /^MER_/.test(l)) || null;
    const merchantName = merchantLines.find((l) => l !== merchantId && l.length > 2 && !/^[A-Z]{2}$/.test(l)) || merchantLines[0];
    const wallet = parseINR(cells[2]);
    const status = cells[3]?.trim();

    merchants.push({ merchantId, merchantName, wallet, status });
  }
  return merchants;
}

async function setStatusFilter(page, statusLabel) {
  // "All statuses" dropdown -> select the given status option.
  const dropdown = page.getByText('All statuses', { exact: true }).first();
  await dropdown.click();
  await page.getByRole('option', { name: statusLabel }).click();
  await page.waitForTimeout(1500);
}

async function scrapeFailedPayouts(page) {
  await page.goto('https://reseller.paynix.co.in/dashboard/transactions', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.getByRole('tab', { name: 'Payouts' }).click();
  await page.waitForTimeout(1500);

  try {
    await setStatusFilter(page, 'Failed');
  } catch (e) {
    console.warn('Could not apply Failed status filter, scraping unfiltered page instead:', e.message);
  }

  const rows = page.locator('table tbody tr');
  const count = await rows.count();
  const failed = [];

  for (let i = 0; i < Math.min(count, 100); i++) {
    const text = await rows.nth(i).innerText();
    const idMatch = text.match(/PAY_OUT_[A-Z0-9]+/);
    const amountMatch = text.match(/₹[\d,]+(\.\d+)?/);
    const reasonMatch = text.match(/Gateway[^\n]+/) || text.match(/Failed\s*\n\s*([^\n]+)/);
    // "10/07/26, 10:59 am" style timestamp — the row's "Created" column.
    const timeMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*[ap]m)/i);
    const merchantLines = text.split('\n').map((s) => s.trim()).filter(Boolean);

    failed.push({
      transactionId: idMatch ? idMatch[0] : null,
      amount: amountMatch ? parseINR(amountMatch[0]) : null,
      reason: reasonMatch ? reasonMatch[reasonMatch.length - 1].trim() : null,
      createdAt: timeMatch ? timeMatch[1] : null,
      raw: merchantLines.slice(0, 6).join(' | '),
    });
  }
  return failed;
}

async function scrapeDashboardSummary(page) {
  await page.goto('https://reseller.paynix.co.in/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const text = await page.locator('body').innerText();

  function num(regex) {
    const m = text.match(regex);
    return m ? m[1] : null;
  }

  return {
    // Header badge "COMMISSION ₹1,74,963.70" — lifetime commission balance,
    // distinct from the "TODAY COMMISSION" / "30-DAY COMMISSION" rolling stats.
    lifetimeCommission: parseINR(num(/\bCOMMISSION\s*\n+\s*(₹[\d,.]+)/)),
    activeMerchants: Number(num(/ACTIVE MERCHANTS\s*\n+\s*(\d+)/)) || null,
    today: {
      payoutTxns: Number(num(/TODAY PAYOUT TXNS[\s\S]*?Live\s*\n+\s*(\d+)/)) || null,
      successVolume: parseINR(num(/PAYOUT\s*\n+Today[\s\S]*?SUCCESS VOLUME\s*\n+\s*(₹[\d,.]+)/)),
      fees: parseINR(num(/TODAY FEES\s*\n+\s*(₹[\d,.]+)/)),
    },
    last30Days: {
      payoutTxns: Number(num(/PAYOUT\s*\n+Last 30 Days\s*\n+\s*(\d+)/)) || null,
      successVolume: parseINR(num(/PAYOUT\s*\n+Last 30 Days[\s\S]*?SUCCESS VOLUME\s*\n+\s*(₹[\d,.]+)/)),
      fees: parseINR(num(/30-DAY FEES\s*\n+\s*(₹[\d,.]+)/)),
    },
  };
}

function loadPreviousSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function computeWalletChanges(previous, current) {
  if (!previous) return [];
  const prevByMerchant = new Map(previous.merchants.map((m) => [m.merchantId, m.wallet]));
  const changes = [];
  for (const m of current.merchants) {
    const prevWallet = prevByMerchant.get(m.merchantId);
    if (prevWallet == null) continue; // new merchant, no baseline
    const delta = Math.round((m.wallet - prevWallet) * 100) / 100;
    if (delta !== 0) {
      changes.push({ merchantId: m.merchantId, merchantName: m.merchantName, previousWallet: prevWallet, currentWallet: m.wallet, delta });
    }
  }
  return changes;
}

function computeNewFailedPayouts(previous, current) {
  // No baseline yet (first-ever run) -> nothing is "new", it's just the
  // starting snapshot. Flagging the whole existing list as new would be a
  // false alarm.
  if (!previous) return [];
  const prevIds = new Set(previous.failedPayouts.map((f) => f.transactionId));
  return current.filter((f) => f.transactionId && !prevIds.has(f.transactionId));
}

async function run() {
  const previous = loadPreviousSnapshot();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Logging into Paynix reseller portal...');
  await page.goto(PAYNIX_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Email address' }).fill(PAYNIX_USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).fill(PAYNIX_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForTimeout(3000);

  console.log('Scraping dashboard summary...');
  const summary = await scrapeDashboardSummary(page);

  console.log('Scraping merchants + wallet balances...');
  const merchants = await scrapeMerchants(page);

  console.log('Scraping failed payouts...');
  const failedPayouts = await scrapeFailedPayouts(page);

  await browser.close();

  const walletChanges = computeWalletChanges(previous, { merchants });
  const newFailedPayouts = computeNewFailedPayouts(previous, failedPayouts);

  const snapshot = {
    scrapedAt: new Date().toISOString(),
    summary,
    merchants,
    failedPayouts,
    walletChanges,
    newFailedPayouts,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Rotate: previous snapshot content is preserved separately before the
  // current file is overwritten, so the next run can diff against it.
  if (fs.existsSync(SNAPSHOT_FILE)) {
    fs.copyFileSync(SNAPSHOT_FILE, PREV_SNAPSHOT_FILE);
  }
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(snapshot, null, 2));

  console.log(`\nSnapshot saved to ${SNAPSHOT_FILE} and ${OUTPUT_JSON}`);
  console.log(`Active merchants: ${summary.activeMerchants}, lifetime commission: Rs ${summary.lifetimeCommission}`);
  console.log(`Failed payouts captured: ${failedPayouts.length} (${newFailedPayouts.length} new since last run)`);
  console.log(`Wallet changes since last run: ${walletChanges.length}`);
}

run().catch((err) => {
  console.error('Paynix scrape failed:', err);
  process.exit(1);
});
