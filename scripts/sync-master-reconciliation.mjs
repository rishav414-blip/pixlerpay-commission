// Syncs the "Master reconciliation" Google Sheet
// (https://docs.google.com/spreadsheets/d/1sH-r3J7SSXDgpdYiiApYdf1j6HGMq3uZdm89YLXanIQ)
// with new entries found in the Paynix records sheet's Sheet1 payout index
// (see sync-sumeet-records.mjs / RECORDS_FILE_ID below).
//
// Unlike the records sheet (a raw uploaded .xlsx, needs Drive files.update),
// this one IS a native Google Sheet (mimeType
// application/vnd.google-apps.spreadsheet), so this uses the Sheets API's
// values.append directly — simpler, no download/edit/re-upload round trip.
// Both sheets use the identical row shape: Merchant, Transaction ID,
// Reference ID, Status, Amount (₹), Fee (₹), GST (₹), Total Debit (₹),
// Beneficiary Name, Account Last 4, IFSC, UTR, Transfer Mode, Gateway,
// Created At (IST), Completed At (IST).
//
// Same OAuth identity as sync-sumeet-records.mjs (rinariapexservices@gmail.com,
// data/gdrive-oauth-token-records.json) — confirmed owner/editor of this
// master sheet too.
//
// Usage: node scripts/sync-master-reconciliation.mjs <FROM> <TO> [--dry-run]
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import xlsx from 'xlsx';
import ExcelJS from 'exceljs';
import { google } from 'googleapis';

const RECORDS_FILE_ID = '1r65sjlbu1pab_fSv5srG552tixgHceOQ'; // source: records .xlsx (Sheet1 = payout index)
const MASTER_SPREADSHEET_ID = '1sH-r3J7SSXDgpdYiiApYdf1j6HGMq3uZdm89YLXanIQ'; // target: native Sheet, "Sheet1" tab
const OAUTH_CLIENT_FILE = './data/gdrive-oauth-client.json';
const OAUTH_TOKEN_FILE = './data/gdrive-oauth-token-records.json';
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');

const FROM = process.argv[2];
const TO = process.argv[3];
const DRY_RUN = process.argv.includes('--dry-run');
if (!FROM || !TO) {
  console.error('Usage: node scripts/sync-master-reconciliation.mjs <FROM> <TO> [--dry-run]');
  process.exit(1);
}

const MERCHANT_NAME_MAP = {
  Sunshine: 'Sunshine Global',
  Curiobyte: 'Curiobyte IT Solution Pvt Ltd',
  Digiroute: 'DIGIROUTE GLOBALTECH SERVICES PRIVATE LIMITED',
  Emervex: 'Emervex Technosoft PVT. LTD',
  Define: 'Define Enterprises',
  Elleaura: 'Elleaura cybertech services pvt ltd',
};

const { PAYNIX_HEADFUL } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

function authClient() {
  const { installed } = JSON.parse(fs.readFileSync(OAUTH_CLIENT_FILE, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(OAUTH_TOKEN_FILE, 'utf-8'));
  const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret);
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(OAUTH_TOKEN_FILE, JSON.stringify(merged, null, 2));
  });
  return oauth2Client;
}

// Dry-run followed by a real run (the normal "preview, then confirm" flow)
// used to re-scrape every merchant portal twice — --dry-run only skipped the
// final Sheets write, not the login+export. Cache each merchant's exported
// rows to disk (keyed by merchantId+date range) for a short TTL so the
// second invocation reuses the first's download instead of re-exporting.
const EXPORT_CACHE_DIR = './data/_export-cache';
const EXPORT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — long enough to cover a dry-run -> confirm -> real-run cycle

function exportCachePath(merchantId, fromDate, toDate) {
  return path.join(EXPORT_CACHE_DIR, `${merchantId}_${fromDate}_${toDate}.json`);
}

function readExportCache(merchantId, fromDate, toDate) {
  const cachePath = exportCachePath(merchantId, fromDate, toDate);
  if (!fs.existsSync(cachePath)) return null;
  const age = Date.now() - fs.statSync(cachePath).mtimeMs;
  if (age > EXPORT_CACHE_TTL_MS) return null;
  return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
}

function writeExportCache(merchantId, fromDate, toDate, rows) {
  fs.mkdirSync(EXPORT_CACHE_DIR, { recursive: true });
  fs.writeFileSync(exportCachePath(merchantId, fromDate, toDate), JSON.stringify(rows));
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
  const tmpPath = path.join('./data', `_master-sync-export-${Date.now()}.xlsx`);
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

async function run() {
  const auth = authClient();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Reading source payout index (records .xlsx, Sheet1)...');
  const res = await drive.files.get({ fileId: RECORDS_FILE_ID, alt: 'media' }, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(res.data);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sourceSheet1 = wb.getWorksheet('Sheet1');
  const sourceEntries = new Map(); // payoutId -> merchant short name
  sourceSheet1.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const payoutId = row.getCell(5).value;
    const merchant = row.getCell(4).value;
    if (payoutId && String(payoutId).trim()) {
      sourceEntries.set(String(payoutId).trim(), merchant ? String(merchant).trim() : null);
    }
  });

  console.log('Reading master reconciliation sheet...');
  const masterRes = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SPREADSHEET_ID, range: 'Sheet1!A:P' });
  const masterRows = masterRes.data.values || [];
  const masterPayoutIds = new Set(masterRows.slice(1).map((r) => (r[1] || '').trim()).filter(Boolean));

  const missing = [...sourceEntries.entries()].filter(([id]) => !masterPayoutIds.has(id));
  console.log(`Source index: ${sourceEntries.size} distinct payoutIds. Master sheet: ${masterPayoutIds.size} existing. Missing from master: ${missing.length}.`);
  if (missing.length === 0) {
    console.log('Nothing to backfill — master sheet already has every payoutId from the records index.');
    return;
  }
  for (const [id, merchant] of missing) console.log(`  MISSING: ${id} (${merchant})`);

  const byLogin = new Map();
  const unmappedMerchants = new Set();
  for (const [id, shortName] of missing) {
    const fullName = MERCHANT_NAME_MAP[shortName];
    if (!fullName) { unmappedMerchants.add(shortName); continue; }
    if (!byLogin.has(fullName)) byLogin.set(fullName, new Set());
    byLogin.get(fullName).add(id);
  }
  if (unmappedMerchants.size) {
    console.warn(`No login mapping for: ${[...unmappedMerchants].join(', ')} — add to MERCHANT_NAME_MAP. Skipping.`);
  }

  const logins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));
  const foundRows = [];
  const stillMissing = new Set(missing.map(([id]) => id));

  const browser = await chromium.launch({ headless });
  for (const [merchantFullName, wantedIds] of byLogin) {
    const login = logins.find((l) => l.merchantName === merchantFullName);
    if (!login) {
      console.warn(`No credentials for "${merchantFullName}" — skipping ${wantedIds.size} payoutId(s).`);
      continue;
    }
    const cached = readExportCache(login.merchantId, FROM, TO);
    if (cached) {
      console.log(`Using cached export for ${login.merchantName} (${login.merchantId}) — from a run within the last ${EXPORT_CACHE_TTL_MS / 60000} min, skipping login+export.`);
      for (const r of cached) {
        if (r.payoutId && wantedIds.has(r.payoutId)) {
          foundRows.push({ merchant: merchantFullName, ...r });
          stillMissing.delete(r.payoutId);
        }
      }
      console.log(`  -> matched ${[...wantedIds].filter((id) => !stillMissing.has(id)).length}/${wantedIds.size} for this merchant.`);
      continue;
    }

    const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
    const page = await context.newPage();
    try {
      console.log(`Logging into ${login.merchantName} (${login.merchantId})...`);
      await page.goto('https://merchant.paynix.co.in/auth/login', { waitUntil: 'domcontentloaded' });
      await page.getByRole('textbox', { name: 'Email address' }).fill(login.username);
      await page.getByRole('textbox', { name: 'Password' }).fill(login.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForTimeout(3000);

      const rows = await exportPayouts(page, FROM, TO);
      writeExportCache(login.merchantId, FROM, TO, rows);
      for (const r of rows) {
        if (r.payoutId && wantedIds.has(r.payoutId)) {
          foundRows.push({ merchant: merchantFullName, ...r });
          stillMissing.delete(r.payoutId);
        }
      }
      console.log(`  -> matched ${[...wantedIds].filter((id) => !stillMissing.has(id)).length}/${wantedIds.size} for this merchant.`);
    } catch (err) {
      console.warn(`  FAILED for ${login.merchantName}: ${err.message}`);
    } finally {
      await context.close();
    }
  }
  await browser.close();

  if (foundRows.length === 0) {
    console.log('\nNo rows matched in the given date window — nothing appended. Try a wider FROM/TO range.');
    return;
  }

  console.log(`\n${foundRows.length} row(s) to append${DRY_RUN ? ' (dry run — not writing)' : ''}:`);
  const values = foundRows.map((r) => [
    r.merchant, r.payoutId, r.referenceId, r.status, r.amount, r.fee, r.gst,
    r.totalDebit, r.beneficiaryName, r.accountLast4, r.ifsc, r.utr,
    r.transferMode, r.gateway, r.createdAt, r.completedAt,
  ]);
  for (const r of foundRows) {
    console.log(`  ADD: ${r.merchant} | ${r.payoutId} | Rs ${r.amount} | ${r.beneficiaryName} | ${r.createdAt}`);
  }
  if (stillMissing.size) {
    console.log(`\nSTILL MISSING (not found in ${FROM}..${TO} window, not appended): ${[...stillMissing].join(', ')}`);
  }

  if (DRY_RUN) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId: MASTER_SPREADSHEET_ID,
    range: 'Sheet1!A:P',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  console.log('\nAppended to master reconciliation sheet.');
}

run().catch((err) => { console.error(err); process.exit(1); });
