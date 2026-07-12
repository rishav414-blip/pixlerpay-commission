// Logs into each of the known individual Paynix merchant portal accounts
// (data/paynix-merchant-logins.json — currently 9 of 13 rate-card clients;
// see HANDOFF.md limitation #7) and exports their full payout history via
// the portal's own Export button, same flow proven in
// download-pixlerpay-merchant.js's exportPayouts(). This is what makes
// margin-based commission (Onboarded% - Reseller%) + AK commission
// computable per Paynix client — the reseller-account dashboard only ever
// exposed wallet balance, never per-merchant transaction volume.
//
// Deliberately does NOT attempt the 4 missing merchants (APAS TECH POINT,
// PPAY SOLUTION, Global Books Trading, Define Enterprises) — they're
// skipped and calculate-paynix-commission.js reports them as
// "no data available" rather than silently showing zero.

import 'dotenv/config';
import { chromium } from 'playwright';
import xlsx from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');
const REPORTS_DIR = path.join('./data', 'paynix-merchant-reports');

const { PAYNIX_HEADFUL } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

async function exportPayouts(page) {
  await page.goto('https://merchant.paynix.co.in/dashboard/payouts', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const exportBtn = page.getByRole('button', { name: /export/i }).first();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    exportBtn.click(),
  ]);

  const tmpPath = path.join('./data', `_paynix-merchant-payouts-export-${Date.now()}.xlsx`);
  await download.saveAs(tmpPath);

  const wb = xlsx.readFile(tmpPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });
  fs.unlinkSync(tmpPath);

  return rows.map((r) => ({
    payoutId: r['Transaction ID'] || null,
    status: r['Status'] || null,
    amount: Number(r['Amount (₹)']) || 0,
    createdAt: r['Created At (IST)'] || null,
  }));
}

function isSuccessful(status) {
  return String(status || '').trim().toUpperCase() === 'SUCCESS';
}

async function run() {
  if (!fs.existsSync(LOGINS_FILE)) {
    console.error(`${LOGINS_FILE} not found — nothing to scrape.`);
    process.exit(1);
  }
  const logins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless });
  let successCount = 0;
  for (const login of logins) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      console.log(`Logging into ${login.merchantName} (${login.merchantId})...`);
      await page.goto(MERCHANT_LOGIN_URL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('textbox', { name: 'Email address' }).fill(login.username);
      await page.getByRole('textbox', { name: 'Password' }).fill(login.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForTimeout(3000);

      const payouts = await exportPayouts(page);
      const success = payouts.filter((p) => isSuccessful(p.status));
      const outFile = path.join(REPORTS_DIR, `${login.merchantId}.json`);
      fs.writeFileSync(outFile, JSON.stringify({
        merchantId: login.merchantId,
        merchantName: login.merchantName,
        scrapedAt: new Date().toISOString(),
        totalPayouts: payouts.length,
        successCount: success.length,
        payouts,
      }, null, 2));
      console.log(`  -> ${payouts.length} payouts (${success.length} success), saved to ${outFile}`);
      successCount++;
    } catch (err) {
      console.warn(`  FAILED for ${login.merchantName}: ${err.message}`);
    } finally {
      await context.close();
    }
  }
  await browser.close();

  console.log(`\nDone: ${successCount}/${logins.length} merchant report(s) exported.`);
  if (successCount < logins.length) {
    console.warn('Some merchants failed — their previous report.json (if any) stays as the last known data.');
  }
}

run().catch((err) => {
  console.error('Paynix merchant report export failed:', err);
  process.exit(1);
});
