// Keeps the "Paynix processing transaction" Google Sheet
// (https://docs.google.com/spreadsheets/d/1xM860Mw63r-rqc-3wYcnJ2ARA2HUMILfFHTzyOt8PwU)
// topped up with every payout currently sitting in PROCESSING status across
// all merchant portals — this had become a recurring manual exercise
// (crosscheck a list of transaction/reference IDs against payout reports,
// hand-copy the PROCESSING ones into the sheet), so it's now a script.
//
// Row shape matches the sheet's existing header exactly (18 columns):
// Merchant | Merchant ID | Transaction ID | Reference ID | Status |
// Amount (₹) | Fee (₹) | GST (₹) | Total Debit (₹) | Beneficiary Name |
// Account Last 4 | IFSC | UTR | Transfer Mode | Gateway | Failure Reason |
// Created At | Updated At — confirmed 2026-08-14 by reading the sheet's
// existing ~133 rows before adding to it.
//
// Source of data: each merchant portal's own authenticated JSON API
// (GET /merchant/portal/transactions/payouts), same endpoint
// download-paynix-merchant-reports.js uses — but unlike that script, this
// one keeps the FULL raw record (reference_id, fee, gst, beneficiary, UTR,
// etc.), not just the 4 stripped fields calculate-paynix-commission.js
// needs. Live-fetched fresh every run rather than read from
// data/paynix-merchant-reports/*.json, since PROCESSING payouts can flip to
// SUCCESS/FAILED between runs and we want current status at append time.
//
// De-dupes against the sheet's own "Transaction ID" column (col C) — safe
// to re-run on a schedule or ad hoc without creating duplicate rows. Does
// NOT update rows already in the sheet if their status has since changed
// (e.g. PROCESSING -> SUCCESS) — this only ever appends newly-seen
// PROCESSING payouts, matching how the sheet has been maintained by hand so
// far. Revisit if the user wants stale-status rows corrected too.
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { loginPaynixMerchant, getAuthenticatedContext } from './lib/paynix-merchant-login.js';
import { getSuspendedMerchantIds } from './lib/suspended-merchants.js';

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
const MERCHANT_DASHBOARD_URL = 'https://merchant.paynix.co.in/dashboard';
const SESSIONS_DIR = path.join('./data', 'paynix-sessions');
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');
const SPREADSHEET_ID = '1xM860Mw63r-rqc-3wYcnJ2ARA2HUMILfFHTzyOt8PwU';
const OAUTH_CLIENT_FILE = './data/gdrive-oauth-client.json';
const OAUTH_TOKEN_FILE = './data/gdrive-oauth-token-records.json'; // same owner (rinariapexservices@gmail.com) as the sheet

// Same window as download-paynix-merchant-reports.js's default — recent
// payouts only, not full lifetime history.
const FETCH_WINDOW_DAYS = Number(process.env.PAYNIX_MERCHANT_FETCH_WINDOW_DAYS) || 3;

const { PAYNIX_HEADFUL, GOOGLE_DRIVE_PAYNIX_FILE_ID, GOOGLE_DRIVE_API_KEY } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';
const DRY_RUN = process.argv.includes('--dry-run');

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

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

async function fetchProcessingPayouts(page, merchantId, fromDate, toDate) {
  return page.evaluate(async ({ merchantId, fromDate, toDate }) => {
    const token = localStorage.getItem('paynix_access_token');
    const headers = { Authorization: `Bearer ${token}` };
    const perPage = 500;
    let pageNum = 1;
    const rows = [];
    while (true) {
      const url = `https://api.paynix.co.in/api/v1/merchant/portal/transactions/payouts?page=${pageNum}&per_page=${perPage}&from=${fromDate}&to=${toDate}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      let res;
      try {
        res = await fetch(url, { headers, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      const json = await res.json();
      if (!json.success) return { error: json };
      const batch = json.data || [];
      for (const t of batch) {
        if (String(t.status || '').trim().toUpperCase() !== 'PROCESSING') continue;
        rows.push([
          null, // merchant name filled in by caller
          merchantId,
          t.transaction_id || '',
          t.reference_id || '',
          t.status || '',
          Number(t.amount) || 0,
          Number(t.fee?.payout_fee) || 0,
          Number(t.fee?.gst) || 0,
          Number(t.total_debit) || 0,
          t.beneficiary?.name || '',
          t.beneficiary?.account_last4 || '',
          t.beneficiary?.ifsc || '',
          t.utr || '',
          t.transfer_mode || '',
          t.gateway || '',
          t.failure_reason || '',
          t.created_at || '',
          t.updated_at || '',
        ]);
      }
      if (batch.length < perPage) break;
      pageNum += 1;
      if (pageNum > 40) break;
    }
    return { rows };
  }, { merchantId, fromDate, toDate });
}

async function run() {
  const auth = authClient();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Reading existing sheet rows (for de-dupe on Transaction ID)...');
  const existingRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'A:C' });
  const existingIds = new Set((existingRes.data.values || []).slice(1).map((r) => (r[2] || '').trim()).filter(Boolean));
  console.log(`Sheet currently has ${existingIds.size} distinct Transaction ID(s).`);

  const logins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));
  const suspendedIds = await getSuspendedMerchantIds(GOOGLE_DRIVE_PAYNIX_FILE_ID, GOOGLE_DRIVE_API_KEY).catch(() => new Set());
  const activeLogins = logins.filter((l) => !suspendedIds.has(l.merchantId));
  if (suspendedIds.size) {
    console.log(`Skipping ${logins.length - activeLogins.length} suspended merchant(s).`);
  }

  const fromDate = isoDaysAgo(FETCH_WINDOW_DAYS);
  const toDate = isoDaysAgo(-1);

  const browser = await chromium.launch({ headless });
  const newRows = [];
  for (const login of activeLogins) {
    const sessionFile = path.join(SESSIONS_DIR, `${login.merchantId}.json`);
    const { context, page, skipped } = await getAuthenticatedContext(browser, {
      sessionFile,
      dashboardUrl: MERCHANT_DASHBOARD_URL,
      performLogin: (p) => loginPaynixMerchant(p, MERCHANT_LOGIN_URL, login.username, login.password),
      merchantLabel: login.merchantName,
    });
    if (skipped) { console.log(`${login.merchantName}: skipped (login backoff)`); continue; }

    try {
      const { rows, error } = await fetchProcessingPayouts(page, login.merchantId, fromDate, toDate);
      if (error) {
        console.warn(`${login.merchantName}: API error — ${JSON.stringify(error).slice(0, 150)}`);
        continue;
      }
      const fresh = rows.filter((r) => r[2] && !existingIds.has(r[2]));
      for (const r of fresh) { r[0] = login.merchantName; existingIds.add(r[2]); }
      console.log(`${login.merchantName}: ${rows.length} PROCESSING payout(s) found, ${fresh.length} new.`);
      newRows.push(...fresh);
    } catch (err) {
      console.warn(`${login.merchantName}: FAILED — ${err.message.slice(0, 150)}`);
    } finally {
      await context.close();
    }
  }
  await browser.close();

  if (newRows.length === 0) {
    console.log('\nNo new PROCESSING payouts to add — sheet is already up to date.');
    return;
  }

  console.log(`\n${newRows.length} new row(s) to append${DRY_RUN ? ' (dry run — not writing)' : ''}:`);
  for (const r of newRows) console.log(`  ADD: ${r[0]} | ${r[2]} | Rs ${r[5]} | ${r[9]} | ${r[16]}`);

  if (DRY_RUN) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'A:R',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: newRows },
  });
  console.log('\nAppended to the processing-transactions sheet.');
}

run().catch((err) => { console.error(err); process.exit(1); });
