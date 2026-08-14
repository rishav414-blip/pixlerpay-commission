// One-off: downloads a full-history payout-report .xlsx (via each
// merchant portal's own Export button — richer than the JSON API used
// for commission calc, includes fee/GST/beneficiary/IFSC/UTR/gateway)
// for every merchant in the Atmoon subset (ATMOON_MERCHANT_IDS, mirrored
// from telegram-alert.js / filter-paynix-atmoon.js).
//
// "Since each merchant went live" = no real lower bound available from
// the portal UI, so this uses a stub FROM date (2020-01-01) far earlier
// than any known onboarding date to guarantee full history is included,
// same technique as sync-master-reconciliation.mjs's exportPayouts().
//
// Usage: node scripts/download-atmoon-payout-reports.mjs
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { loginPaynixMerchant } from './lib/paynix-merchant-login.js';

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');
const OUT_DIR = path.join('./data', 'atmoon-payout-reports');

const FROM = '2020-01-01';
const TO = new Date().toISOString().slice(0, 10);

const ATMOON_MERCHANT_IDS = new Set([
  'MER_F2155A2A1F99', // SHESTYLE BULK TRADERS PRIVATE LIMITED
  'MER_0D622C7553A1', // RAAMIRO TRINTROY PRIVATE LIMITED
  'MER_E75F374D3B5A', // WILDBADGER TECHNOLOGY PRIVATE LIMITED
  'MER_CC95D8E2A947', // TECHMARKETIQ TECHNOLOGY PRIVATE LIMITED
  'MER_81FB09B83B4C', // KAHUA SYSTEMS PRIVATE LIMITED
  'MER_EB9A8C4D9025', // VIKZONE TECHNOLOGY PRIVATE LIMITED
  'MER_EB1BE5D25983', // VYSHIKAX TECHNOLOGY PRIVATE LIMITED
  'MER_810B49283330', // VELCYNTRA TECHNOLOGIES PRIVATE LIMITED
  'MER_19F368135CE0', // ZYPHERON TECHNOLOGY PRIVATE LIMITED
  'MER_1F18C5EDCA3B', // RASHEEYA TECHNOLOGY PRIVATE LIMITED
  'MER_BE152E9A611E', // PARAKEET ENGINEERING PVT LTD
  'MER_DBC71D6C79ED', // SURAJ WELLNESS PRIVATE LIMITED
]);

const { PAYNIX_HEADFUL } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

function safeName(name) {
  return name.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}

async function exportPayouts(page, merchantName) {
  await page.goto('https://merchant.paynix.co.in/dashboard/payouts', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const dateInputs = page.locator('input[type="date"]');
  if (await dateInputs.count() >= 2) {
    await dateInputs.nth(0).fill(FROM);
    await dateInputs.nth(1).fill(TO);
    const applyBtn = page.getByRole('button', { name: /apply/i }).first();
    if (await applyBtn.count()) {
      await applyBtn.click();
      await page.waitForTimeout(1500);
    }
  }
  const exportBtn = page.getByRole('button', { name: /export/i }).first();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    exportBtn.click(),
  ]);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${safeName(merchantName)}_${FROM}_to_${TO}.xlsx`);
  await download.saveAs(outPath);
  return outPath;
}

async function run() {
  const allLogins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));
  const logins = allLogins.filter((l) => ATMOON_MERCHANT_IDS.has(l.merchantId));
  console.log(`Downloading full-history payout report for ${logins.length} Atmoon merchant(s), range ${FROM}..${TO}...`);

  const results = [];
  const browser = await chromium.launch({ headless });
  for (const login of logins) {
    const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
    const page = await context.newPage();
    try {
      console.log(`Logging into ${login.merchantName} (${login.merchantId})...`);
      await loginPaynixMerchant(page, MERCHANT_LOGIN_URL, login.username, login.password);
      const outPath = await exportPayouts(page, login.merchantName);
      console.log(`  -> saved ${outPath}`);
      results.push({ merchantName: login.merchantName, merchantId: login.merchantId, file: outPath, status: 'ok' });
    } catch (err) {
      console.warn(`  FAILED for ${login.merchantName}: ${err.message}`);
      results.push({ merchantName: login.merchantName, merchantId: login.merchantId, error: err.message, status: 'failed' });
    } finally {
      await context.close();
    }
  }
  await browser.close();

  const ok = results.filter((r) => r.status === 'ok');
  const failed = results.filter((r) => r.status === 'failed');
  console.log(`\nDone: ${ok.length}/${logins.length} report(s) downloaded to ${OUT_DIR}/`);
  if (failed.length) {
    console.log(`Failed: ${failed.map((f) => f.merchantName).join(', ')}`);
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
