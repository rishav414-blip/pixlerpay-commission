// One-off: scans each merchant portal's wallet Transaction History for
// CREDIT/REFUND entries (shown in the UI as "CREDITREFUND", API category
// REFUND) in a date range, then cross-checks each refunded payoutId
// (API field referenceId, e.g. PAY_OUT_00BFC6E2588C) against the Master
// reconciliation Google Sheet, keyed on payoutId as primary key.
//
// Uses the wallet/transactions REST API directly (not DOM scraping) —
// found via network inspection: GET
// https://api.paynix.co.in/api/v1/merchant/portal/wallet/transactions?page=N&per_page=100
// with the same Bearer token used by fetch-merchant-payouts-range.mjs.
//
// Usage: node scripts/check-refunds-against-master.mjs <FROM> <TO>
// FROM/TO are YYYY-MM-DD, inclusive, compared against each entry's createdAt (UTC).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { google } from 'googleapis';
import { loginPaynixMerchant } from './lib/paynix-merchant-login.js';

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');
const MASTER_SPREADSHEET_ID = '1sH-r3J7SSXDgpdYiiApYdf1j6HGMq3uZdm89YLXanIQ';
const OAUTH_CLIENT_FILE = './data/gdrive-oauth-client.json';
const OAUTH_TOKEN_FILE = './data/gdrive-oauth-token-records.json';

const FROM = process.argv[2];
const TO = process.argv[3];
if (!FROM || !TO) {
  console.error('Usage: node scripts/check-refunds-against-master.mjs <FROM> <TO>');
  process.exit(1);
}
const fromDate = new Date(FROM + 'T00:00:00Z');
const toDate = new Date(TO + 'T23:59:59Z');

const { PAYNIX_HEADFUL } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

function authClient() {
  const { installed } = JSON.parse(fs.readFileSync(OAUTH_CLIENT_FILE, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(OAUTH_TOKEN_FILE, 'utf-8'));
  const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret);
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

async function fetchRefunds(page, merchantName) {
  const refunds = [];
  let pageNum = 1;
  const perPage = 100;
  for (;;) {
    const result = await page.evaluate(async ({ pageNum, perPage }) => {
      const token = localStorage.getItem('paynix_access_token');
      const res = await fetch(
        `https://api.paynix.co.in/api/v1/merchant/portal/wallet/transactions?page=${pageNum}&per_page=${perPage}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return res.json();
    }, { pageNum, perPage });

    const data = result?.data || [];
    if (data.length === 0) break;

    let hitOlderThanFrom = false;
    for (const tx of data) {
      const createdAt = new Date(tx.createdAt);
      if (createdAt < fromDate) { hitOlderThanFrom = true; continue; }
      if (createdAt > toDate) continue;
      if (tx.type === 'CREDIT' && tx.category === 'REFUND') {
        refunds.push({
          merchant: merchantName,
          payoutId: tx.referenceId,
          amount: tx.amount,
          createdAt: tx.createdAt,
          description: tx.description,
        });
      }
    }
    // Ledger is newest-first; once we've passed the FROM boundary, stop paging.
    if (hitOlderThanFrom || data.length < perPage) break;
    pageNum++;
  }
  return refunds;
}

async function run() {
  const logins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));
  const allRefunds = [];
  const failedLogins = [];

  const browser = await chromium.launch({ headless });
  for (const login of logins) {
    const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
    const page = await context.newPage();
    try {
      console.log(`Logging into ${login.merchantName} (${login.merchantId})...`);
      await loginPaynixMerchant(page, MERCHANT_LOGIN_URL, login.username, login.password);
      const refunds = await fetchRefunds(page, login.merchantName);
      console.log(`  -> ${refunds.length} refund(s) in range.`);
      allRefunds.push(...refunds);
    } catch (err) {
      console.warn(`  FAILED for ${login.merchantName}: ${err.message}`);
      failedLogins.push(login.merchantName);
    } finally {
      await context.close();
    }
  }
  await browser.close();

  console.log(`\nTotal refund entries found across all merchants: ${allRefunds.length}`);
  if (failedLogins.length) {
    console.log(`Could not check (login failed): ${failedLogins.join(', ')}`);
  }

  console.log('\nReading Master reconciliation sheet...');
  const auth = authClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const masterRes = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SPREADSHEET_ID, range: 'Sheet1!A:P' });
  const masterRows = masterRes.data.values || [];
  const masterByPayoutId = new Map();
  for (const row of masterRows.slice(1)) {
    const payoutId = (row[1] || '').trim();
    if (payoutId) masterByPayoutId.set(payoutId, { status: row[3] || null, amount: row[4] || null, row });
  }
  console.log(`Master sheet has ${masterByPayoutId.size} distinct payoutId rows.`);

  const missing = [];
  const statusMismatch = [];
  const ok = [];

  for (const r of allRefunds) {
    const masterEntry = masterByPayoutId.get(r.payoutId);
    if (!masterEntry) {
      missing.push(r);
      continue;
    }
    const status = (masterEntry.status || '').toLowerCase();
    const looksRefundAware = /refund|fail|revers|charge.?back/.test(status);
    if (!looksRefundAware) {
      statusMismatch.push({ ...r, masterStatus: masterEntry.status });
    } else {
      ok.push(r);
    }
  }

  console.log(`\n=== RESULTS (${FROM} to ${TO}) ===`);
  console.log(`Refunds correctly reflected in master sheet: ${ok.length}`);
  console.log(`Refunds MISSING from master sheet entirely: ${missing.length}`);
  console.log(`Refunds present in master sheet but status doesn't mention refund/fail: ${statusMismatch.length}`);

  if (missing.length) {
    console.log('\n--- MISSING FROM MASTER SHEET ---');
    for (const r of missing) {
      console.log(`  ${r.payoutId} | ${r.merchant} | Rs ${r.amount} | ${r.createdAt}`);
    }
  }
  if (statusMismatch.length) {
    console.log('\n--- STATUS MISMATCH (refunded on Paynix, but master sheet says otherwise) ---');
    for (const r of statusMismatch) {
      console.log(`  ${r.payoutId} | ${r.merchant} | Rs ${r.amount} | master status: "${r.masterStatus}"`);
    }
  }

  fs.writeFileSync('./data/_refund-crosscheck-result.json', JSON.stringify({ FROM, TO, allRefunds, missing, statusMismatch, ok, failedLogins }, null, 2));
  console.log('\nFull result saved to data/_refund-crosscheck-result.json');
}

run().catch((err) => { console.error(err); process.exit(1); });
