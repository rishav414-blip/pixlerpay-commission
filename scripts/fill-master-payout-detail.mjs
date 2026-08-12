// Fetches full detail for ONE specific payoutId from a given Paynix login
// (PixlerPay's own merchant account, or one of the 9 reseller-merchant
// portals in data/paynix-merchant-logins.json) and writes it into the
// master reconciliation sheet
// (https://docs.google.com/spreadsheets/d/1sH-r3J7SSXDgpdYiiApYdf1j6HGMq3uZdm89YLXanIQ).
//
// Handles two cases, found 2026-07-20:
// - The row doesn't exist yet -> appends a new row (same as
//   sync-master-reconciliation.mjs, but for one explicit payoutId/login
//   pair instead of diffing against the records-sheet index).
// - A STUB row already exists (Transaction ID filled in column B, every
//   other column blank — seen for PAY_OUT_05AB10B2A93D, presumably added by
//   hand as a placeholder/request) -> updates that row in place instead of
//   appending a duplicate. Always check for this before appending.
//
// Usage: node scripts/fill-master-payout-detail.mjs <PAYOUT_ID> <LOGIN> <FROM> <TO> [--dry-run]
//   LOGIN = "pixlerpay" (PixlerPay's own account) or a merchantName from
//   data/paynix-merchant-logins.json (e.g. "Sunshine Global").
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import xlsx from 'xlsx';
import { google } from 'googleapis';
import { loginPaynixMerchant } from './lib/paynix-merchant-login.js';

const MASTER_SPREADSHEET_ID = '1sH-r3J7SSXDgpdYiiApYdf1j6HGMq3uZdm89YLXanIQ';
const OAUTH_CLIENT_FILE = './data/gdrive-oauth-client.json';
const OAUTH_TOKEN_FILE = './data/gdrive-oauth-token-records.json';
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');

const PAYOUT_ID = process.argv[2];
const LOGIN_ARG = process.argv[3];
const FROM = process.argv[4];
const TO = process.argv[5];
const DRY_RUN = process.argv.includes('--dry-run');
if (!PAYOUT_ID || !LOGIN_ARG || !FROM || !TO) {
  console.error('Usage: node scripts/fill-master-payout-detail.mjs <PAYOUT_ID> <LOGIN> <FROM> <TO> [--dry-run]');
  console.error('  LOGIN = "pixlerpay" or a merchantName from data/paynix-merchant-logins.json');
  process.exit(1);
}

const { PAYNIX_HEADFUL } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

function resolveLogin() {
  if (LOGIN_ARG.toLowerCase() === 'pixlerpay') {
    const { PIXLERPAY_MERCHANT_LOGIN_URL, PIXLERPAY_MERCHANT_USERNAME, PIXLERPAY_MERCHANT_PASSWORD } = process.env;
    if (!PIXLERPAY_MERCHANT_USERNAME || !PIXLERPAY_MERCHANT_PASSWORD) {
      console.error('Missing PIXLERPAY_MERCHANT_USERNAME / PIXLERPAY_MERCHANT_PASSWORD in .env.');
      process.exit(1);
    }
    return {
      merchantLabel: 'PixlerPay (own account)',
      loginUrl: PIXLERPAY_MERCHANT_LOGIN_URL || 'https://merchant.paynix.co.in/auth/login',
      username: PIXLERPAY_MERCHANT_USERNAME,
      password: PIXLERPAY_MERCHANT_PASSWORD,
    };
  }
  const logins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));
  const login = logins.find((l) => l.merchantName === LOGIN_ARG);
  if (!login) {
    console.error(`No login found for "${LOGIN_ARG}" in ${LOGINS_FILE}, and it isn't "pixlerpay". Known merchantNames: ${logins.map((l) => l.merchantName).join(', ')}`);
    process.exit(1);
  }
  return {
    merchantLabel: login.merchantName,
    loginUrl: 'https://merchant.paynix.co.in/auth/login',
    username: login.username,
    password: login.password,
  };
}

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
  const tmpPath = path.join('./data', `_payout-lookup-${Date.now()}.xlsx`);
  await download.saveAs(tmpPath);
  const wb = xlsx.readFile(tmpPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });
  fs.unlinkSync(tmpPath);
  return rows.map((r) => ({
    payoutId: r['Transaction ID'] || null,
    referenceId: r['Reference ID'] || null,
    status: r['Status'] || null,
    amount: Number(r['Amount (₹)']) || 0,
    fee: Number(r['Fee (₹)']) || 0,
    gst: Number(r['GST (₹)']) || 0,
    totalDebit: Number(r['Total Debit (₹)']) || 0,
    beneficiaryName: r['Beneficiary Name'] || null,
    accountLast4: r['Account Last 4'] || null,
    ifsc: r['IFSC'] || null,
    utr: r['UTR'] || null,
    transferMode: r['Transfer Mode'] || null,
    gateway: r['Gateway'] || null,
    createdAt: r['Created At (IST)'] || null,
    completedAt: r['Completed At (IST)'] || null,
  }));
}

function authClient() {
  const { installed } = JSON.parse(fs.readFileSync(OAUTH_CLIENT_FILE, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(OAUTH_TOKEN_FILE, 'utf-8'));
  const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret);
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

async function run() {
  const login = resolveLogin();

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();

  console.log(`Logging into ${login.merchantLabel}...`);
  await loginPaynixMerchant(page, login.loginUrl, login.username, login.password);

  console.log(`Exporting payouts ${FROM}..${TO} to find ${PAYOUT_ID}...`);
  const rows = await exportPayouts(page, FROM, TO);
  await browser.close();

  const match = rows.find((r) => r.payoutId === PAYOUT_ID);
  if (!match) {
    console.error(`${PAYOUT_ID} not found in ${FROM}..${TO} window (${rows.length} rows scanned). Try a wider range.`);
    process.exit(1);
  }
  console.log('Found:', JSON.stringify(match, null, 2));

  const auth = authClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const masterRes = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SPREADSHEET_ID, range: 'Sheet1!A:P' });
  const masterRows = masterRes.data.values || [];
  const rowIndex = masterRows.findIndex((r) => (r[1] || '').trim() === PAYOUT_ID); // 0-based, includes header

  const newRow = [
    login.merchantLabel, match.payoutId, match.referenceId, match.status, match.amount,
    match.fee, match.gst, match.totalDebit, match.beneficiaryName, match.accountLast4,
    match.ifsc, match.utr, match.transferMode, match.gateway, match.createdAt, match.completedAt,
  ];

  if (rowIndex === -1) {
    console.log(DRY_RUN ? '\n(dry run) Would APPEND new row:' : '\nAppending new row:', JSON.stringify(newRow));
    if (DRY_RUN) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SPREADSHEET_ID,
      range: 'Sheet1!A:P',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [newRow] },
    });
    console.log(`Appended ${PAYOUT_ID} to master reconciliation sheet.`);
    return;
  }

  const existing = masterRows[rowIndex];
  const isFullyPopulated = existing.length >= 16 && existing.slice(2).every((v) => v !== undefined && v !== '');
  if (isFullyPopulated) {
    console.log(`${PAYOUT_ID} already has a complete row at Sheet1!${rowIndex + 1} — not overwriting. Existing:`, JSON.stringify(existing));
    return;
  }

  const sheetRowNum = rowIndex + 1; // values.get is 1:1 with sheet rows (header included)
  console.log(`${PAYOUT_ID} exists as a stub at Sheet1!A${sheetRowNum} (only ${existing.filter(Boolean).length} of 16 columns filled) — filling in details.`);
  if (DRY_RUN) {
    console.log('(dry run) Would UPDATE row with:', JSON.stringify(newRow));
    return;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: MASTER_SPREADSHEET_ID,
    range: `Sheet1!A${sheetRowNum}:P${sheetRowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [newRow] },
  });
  console.log(`Updated Sheet1!A${sheetRowNum} with full details for ${PAYOUT_ID}.`);
}

run().catch((err) => { console.error(err); process.exit(1); });
