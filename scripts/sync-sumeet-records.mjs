// Paynix reconciliation "records" sheet sync (one-off / on-demand, not part
// of npm run all): the records sheet
// (https://docs.google.com/spreadsheets/d/1r65sjlbu1pab_fSv5srG552tixgHceOQ)
// is a plain uploaded .xlsx file in Drive (mimeType
// application/vnd.openxmlformats-officedocument.spreadsheetml.sheet), NOT a
// native Google Sheet — confirmed via a 400 "must not be an Office file"
// error from the Sheets API. So this does NOT use the Sheets API; it
// downloads the raw file, edits it with ExcelJS (preserves cell
// styling — the plain `xlsx` package in this repo's deps cannot write
// styles, per HANDOFF.md), and re-uploads in place via the same Drive OAuth
// `files.update` call `upload-to-drive.js` already uses (same client/token,
// scope `https://www.googleapis.com/auth/drive` already covers this).
//
// Workflow:
// 1. Download the workbook, read "Sheet1" (UTR/ORDERID/System ID/Payout
//    Name/Payour Tnx ID/Status — the payout index) and "Sumeet" (the detail
//    table: Merchant/Transaction ID/.../Completed At (IST)).
// 2. Diff: any Sheet1 "Payour Tnx ID" not present as a "Transaction ID" in
//    Sumeet is a new entry needing backfill.
// 3. For each, log into the owning merchant's Paynix portal (mapped from
//    Sheet1's short "Payout Name" to data/paynix-merchant-logins.json's
//    full merchantName) and xlsx-export payouts over FROM..TO, matching by
//    payoutId (same technique as fetch-sumeet-records.mjs).
// 4. Append matched rows to the Sumeet worksheet, copying the style of the
//    last existing data row cell-by-cell so new rows look identical.
// 5. Re-upload the edited workbook to the SAME Drive file ID (in place —
//    same URL/gid, does not create a duplicate).
//
// Usage: node scripts/sync-sumeet-records.mjs <FROM> <TO> [--dry-run]
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { chromium } from 'playwright';
import xlsx from 'xlsx';
import ExcelJS from 'exceljs';
import { google } from 'googleapis';

const RECORDS_FILE_ID = '1r65sjlbu1pab_fSv5srG552tixgHceOQ';
const OAUTH_CLIENT_FILE = './data/gdrive-oauth-client.json';
// Uses the rinariapexservices@gmail.com token (separate from the main
// pipeline's rishav414@gmail.com token in gdrive-oauth-token.json) because
// only rinariapexservices@gmail.com has edit access to the records file —
// rishav414@gmail.com only has "anyone with link -> reader" on it.
const OAUTH_TOKEN_FILE = './data/gdrive-oauth-token-records.json';
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');

const FROM = process.argv[2];
const TO = process.argv[3];
const DRY_RUN = process.argv.includes('--dry-run');
if (!FROM || !TO) {
  console.error('Usage: node scripts/sync-sumeet-records.mjs <FROM> <TO> [--dry-run]');
  process.exit(1);
}

// Sheet1's short "Payout Name" -> full merchantName in paynix-merchant-logins.json.
// Extend this map if the records sheet starts logging a merchant not yet seen here.
const MERCHANT_NAME_MAP = {
  Sunshine: 'Sunshine Global',
  Curiobyte: 'Curiobyte IT Solution Pvt Ltd',
  Digiroute: 'DIGIROUTE GLOBALTECH SERVICES PRIVATE LIMITED',
  Emervex: 'Emervex Technosoft PVT. LTD',
};

const { PAYNIX_HEADFUL } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

function driveClient() {
  const { installed } = JSON.parse(fs.readFileSync(OAUTH_CLIENT_FILE, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(OAUTH_TOKEN_FILE, 'utf-8'));
  const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret);
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(OAUTH_TOKEN_FILE, JSON.stringify(merged, null, 2));
  });
  return google.drive({ version: 'v3', auth: oauth2Client });
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
  const tmpPath = path.join('./data', `_sumeet-sync-export-${Date.now()}.xlsx`);
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
  const drive = driveClient();

  console.log('Downloading records sheet from Drive...');
  const res = await drive.files.get({ fileId: RECORDS_FILE_ID, alt: 'media' }, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(res.data);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet1 = wb.getWorksheet('Sheet1');
  const sumeet = wb.getWorksheet('Sumeet');
  if (!sheet1 || !sumeet) {
    console.error(`Expected worksheets "Sheet1" and "Sumeet", found: ${wb.worksheets.map((w) => w.name).join(', ')}`);
    process.exit(1);
  }

  // Sheet1 columns: [Merchant?-blank, UTR, ORDERID, System ID, Payout Name, Payour Tnx ID, Status]
  const sheet1Entries = new Map(); // payoutId -> merchant short name
  sheet1.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const payoutId = row.getCell(5).value;
    const merchant = row.getCell(4).value;
    if (payoutId && String(payoutId).trim()) {
      sheet1Entries.set(String(payoutId).trim(), merchant ? String(merchant).trim() : null);
    }
  });

  const sumeetPayoutIds = new Set();
  sumeet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const id = row.getCell(2).value;
    if (id) sumeetPayoutIds.add(String(id).trim());
  });

  const missing = [...sheet1Entries.entries()].filter(([id]) => !sumeetPayoutIds.has(id));
  console.log(`Sheet1: ${sheet1Entries.size} distinct payoutIds. Sumeet: ${sumeetPayoutIds.size} existing. Missing: ${missing.length}.`);
  if (missing.length === 0) {
    console.log('Nothing to backfill — Sumeet is already in sync with Sheet1.');
    return;
  }
  for (const [id, merchant] of missing) console.log(`  MISSING: ${id} (${merchant})`);

  // Group missing payoutIds by which merchant login owns them.
  const byLogin = new Map(); // merchantName -> Set(payoutId)
  const unmappedMerchants = new Set();
  for (const [id, shortName] of missing) {
    const fullName = MERCHANT_NAME_MAP[shortName];
    if (!fullName) {
      unmappedMerchants.add(shortName);
      continue;
    }
    if (!byLogin.has(fullName)) byLogin.set(fullName, new Set());
    byLogin.get(fullName).add(id);
  }
  if (unmappedMerchants.size) {
    console.warn(`No login mapping for merchant name(s): ${[...unmappedMerchants].join(', ')} — add to MERCHANT_NAME_MAP in this script. Skipping their payoutIds.`);
  }

  const logins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));
  const foundRows = []; // { payoutId, merchant, ...detail }
  const stillMissing = new Set(missing.map(([id]) => id));

  const browser = await chromium.launch({ headless });
  for (const [merchantFullName, wantedIds] of byLogin) {
    const login = logins.find((l) => l.merchantName === merchantFullName);
    if (!login) {
      console.warn(`No credentials in ${LOGINS_FILE} for "${merchantFullName}" — skipping ${wantedIds.size} payoutId(s).`);
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
    console.log('\nNo rows matched in the given date window — nothing written. Try a wider FROM/TO range.');
    return;
  }

  // Copy style from the last existing Sumeet data row so new rows match formatting.
  const templateRowNumber = sumeet.rowCount;
  const templateRow = sumeet.getRow(templateRowNumber);

  for (const r of foundRows) {
    const newRow = sumeet.addRow([
      r.merchant, r.payoutId, r.referenceId, r.status, r.amount, r.fee, r.gst,
      r.totalDebit, r.beneficiaryName, r.accountLast4, r.ifsc, r.utr,
      r.transferMode, r.gateway, r.createdAt, r.completedAt,
    ]);
    for (let col = 1; col <= 16; col++) {
      newRow.getCell(col).style = { ...templateRow.getCell(col).style };
    }
  }

  console.log(`\nWriting ${foundRows.length} new row(s) to the Sumeet sheet${DRY_RUN ? ' (dry run — not uploading)' : ''}...`);
  for (const r of foundRows) {
    console.log(`  ADDED: ${r.merchant} | ${r.payoutId} | Rs ${r.amount} | ${r.beneficiaryName} | ${r.createdAt}`);
  }
  if (stillMissing.size) {
    console.log(`\nSTILL MISSING (not found in ${FROM}..${TO} window, not written): ${[...stillMissing].join(', ')}`);
  }

  if (DRY_RUN) return;

  const outBuffer = await wb.xlsx.writeBuffer();
  await drive.files.update({
    fileId: RECORDS_FILE_ID,
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: Readable.from(outBuffer),
    },
  });
  console.log('\nUploaded updated records sheet back to Drive (same file ID, in place).');
}

run().catch((err) => { console.error(err); process.exit(1); });
