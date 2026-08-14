// Reverse direction of check-refunds-against-master.mjs: instead of
// scanning every merchant portal's full wallet ledger for refunds and then
// looking each one up in the Master reconciliation sheet, start from the
// Master sheet's own payoutId list, group by the merchant it already names,
// and only log into portals that actually have rows there. Avoids pointless
// logins (and Paynix OTP rate-limit hits) against merchants with zero
// entries in the sheet.
//
// For each payoutId in the sheet, finds its current wallet ledger entries
// (DEBITPAYOUT + any CREDITREFUND against it) via the same
// /wallet/transactions API used by check-refunds-against-master.mjs, and
// flags cases where the sheet's Status column doesn't reflect a refund that
// has since happened.
//
// Usage: node scripts/check-master-payouts-status.mjs
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { google } from 'googleapis';
import { loginPaynixMerchant } from './lib/paynix-merchant-login.js';

const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');
const SNAPSHOT_FILE = path.join('./data', 'paynix-snapshot.json');
const MASTER_SPREADSHEET_ID = '1sH-r3J7SSXDgpdYiiApYdf1j6HGMq3uZdm89YLXanIQ';
const OAUTH_CLIENT_FILE = './data/gdrive-oauth-client.json';
const OAUTH_TOKEN_FILE = './data/gdrive-oauth-token-records.json';
const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';

const { PAYNIX_HEADFUL, PIXLERPAY_MERCHANT_LOGIN_URL, PIXLERPAY_MERCHANT_USERNAME, PIXLERPAY_MERCHANT_PASSWORD } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

function authClient() {
  const { installed } = JSON.parse(fs.readFileSync(OAUTH_CLIENT_FILE, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(OAUTH_TOKEN_FILE, 'utf-8'));
  const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret);
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

// Fetch all wallet transactions whose referenceId is in wantedIds. Pages
// back through the ledger until every wanted id has been found or the
// ledger is exhausted (payoutIds in the sheet can be old, so no date
// shortcut like the full-scan script's fromDate cutoff).
async function fetchTxnsForIds(page, wantedIds) {
  const found = new Map(); // payoutId -> { debit, refunds: [] }
  let pageNum = 1;
  const perPage = 100;
  const remaining = new Set(wantedIds);
  for (;;) {
    const result = await page.evaluate(async ({ pageNum, perPage }) => {
      const token = localStorage.getItem('paynix_access_token');
      const res = await fetch(
        `https://api.paynix.co.in/api/v1/merchant/portal/wallet/transactions?page=${pageNum}&per_page=${perPage}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return res.json();
    }, { pageNum, perPage });

    let data = result?.data || [];
    if (data.length === 0) {
      // Could be a genuine end-of-ledger, or a transient API hiccup —
      // confirmed 2026-08-10 that a bare empty response on some page N
      // does NOT reliably mean the ledger ends there (found a payoutId on
      // page 118 for an account after this loop previously gave up
      // early). Retry once before trusting it.
      await page.waitForTimeout(500);
      const retry = await page.evaluate(async ({ pageNum, perPage }) => {
        const token = localStorage.getItem('paynix_access_token');
        const res = await fetch(
          `https://api.paynix.co.in/api/v1/merchant/portal/wallet/transactions?page=${pageNum}&per_page=${perPage}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return res.json();
      }, { pageNum, perPage });
      data = retry?.data || [];
      if (data.length === 0) break;
    }

    for (const tx of data) {
      const id = tx.referenceId;
      if (!id || !wantedIds.has(id)) continue;
      if (!found.has(id)) found.set(id, { debit: null, refunds: [] });
      const entry = found.get(id);
      if (tx.type === 'DEBIT' && tx.category === 'PAYOUT') entry.debit = tx;
      if (tx.type === 'CREDIT' && tx.category === 'REFUND') entry.refunds.push(tx);
      remaining.delete(id);
    }

    if (remaining.size === 0) break;
    if (data.length < perPage) break; // last page
    pageNum++;
    await page.waitForTimeout(150); // light throttle to avoid tripping Paynix API rate limits over long paginated searches
    if (pageNum > 1500) { console.warn('  Stopped after 1500 pages — giving up on remaining ids.'); break; }
  }
  return found;
}

async function run() {
  const auth = authClient();
  const sheets = google.sheets({ version: 'v4', auth });
  console.log('Reading Master reconciliation sheet...');
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SPREADSHEET_ID, range: 'Sheet1!A:P' });
  const rows = res.data.values || [];

  const byMerchant = new Map(); // merchant name (as written in sheet) -> Set(payoutId)
  const rowByPayoutId = new Map(); // payoutId -> { merchant, status, rowNumber }
  rows.slice(1).forEach((r, i) => {
    const merchant = (r[0] || '').trim();
    const payoutId = (r[1] || '').trim();
    const status = r[3] || null;
    if (!merchant || !payoutId) return;
    if (!byMerchant.has(merchant)) byMerchant.set(merchant, new Set());
    byMerchant.get(merchant).add(payoutId);
    rowByPayoutId.set(payoutId, { merchant, status, rowNumber: i + 2 });
  });

  console.log(`Master sheet: ${rowByPayoutId.size} payoutIds across ${byMerchant.size} merchant(s):`);
  for (const [m, ids] of byMerchant) console.log(`  ${m}: ${ids.size}`);

  // Never attempt logins for suspended merchants — their portal auth
  // reliably fails (token never issued), so it's a guaranteed wasted
  // attempt, not a real check. Per explicit user instruction 2026-08-10 —
  // see memory pixlerpay-skip-suspended-merchants.
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
  const snapshotMerchants = snapshot.merchants || snapshot.data || [];
  const suspendedIds = new Set(snapshotMerchants.filter((m) => m.status === 'Suspended').map((m) => m.merchantId || m.id));

  const logins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));
  const results = []; // { payoutId, merchant, sheetStatus, actualState }
  const skippedMerchants = [];

  for (const merchantName of [...byMerchant.keys()]) {
    const login = logins.find((l) => l.merchantName === merchantName);
    if (login && suspendedIds.has(login.merchantId)) {
      console.log(`Skipping ${merchantName} (${login.merchantId}) — flagged Suspended, not attempting login.`);
      skippedMerchants.push(`${merchantName} (suspended)`);
      byMerchant.delete(merchantName);
    }
  }

  const browser = await chromium.launch({ headless });
  for (const [merchantName, wantedIds] of byMerchant) {
    if (merchantName === 'PixlerPay (own account)') {
      if (!PIXLERPAY_MERCHANT_USERNAME || !PIXLERPAY_MERCHANT_PASSWORD) {
        console.warn(`Skipping "${merchantName}" — no PIXLERPAY_MERCHANT_USERNAME/PASSWORD in .env.`);
        skippedMerchants.push(merchantName);
        continue;
      }
      const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
      const page = await context.newPage();
      try {
        console.log(`Logging into ${merchantName} (PixlerPay's own Paynix account)...`);
        await loginPaynixMerchant(page, PIXLERPAY_MERCHANT_LOGIN_URL || MERCHANT_LOGIN_URL, PIXLERPAY_MERCHANT_USERNAME, PIXLERPAY_MERCHANT_PASSWORD);
        const found = await fetchTxnsForIds(page, wantedIds);
        for (const id of wantedIds) {
          const entry = found.get(id);
          const sheetInfo = rowByPayoutId.get(id);
          results.push({ payoutId: id, merchant: merchantName, sheetStatus: sheetInfo.status, rowNumber: sheetInfo.rowNumber, found: !!entry, refunded: (entry?.refunds.length || 0) > 0, refundAmount: entry?.refunds.reduce((s, r) => s + r.amount, 0) || 0 });
        }
        console.log(`  -> checked ${wantedIds.size} payoutId(s), ${found.size} found in ledger.`);
      } catch (err) {
        console.warn(`  FAILED for ${merchantName}: ${err.message}`);
        skippedMerchants.push(merchantName);
      } finally {
        await context.close();
      }
      continue;
    }

    const login = logins.find((l) => l.merchantName === merchantName);
    if (!login) {
      console.warn(`No login credentials found for "${merchantName}" (as named in the sheet) — skipping ${wantedIds.size} payoutId(s).`);
      skippedMerchants.push(merchantName);
      continue;
    }

    const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
    const page = await context.newPage();
    try {
      console.log(`Logging into ${merchantName} (${login.merchantId})...`);
      await loginPaynixMerchant(page, MERCHANT_LOGIN_URL, login.username, login.password);
      const found = await fetchTxnsForIds(page, wantedIds);
      for (const id of wantedIds) {
        const entry = found.get(id);
        const sheetInfo = rowByPayoutId.get(id);
        results.push({ payoutId: id, merchant: merchantName, sheetStatus: sheetInfo.status, rowNumber: sheetInfo.rowNumber, found: !!entry, refunded: (entry?.refunds.length || 0) > 0, refundAmount: entry?.refunds.reduce((s, r) => s + r.amount, 0) || 0 });
      }
      console.log(`  -> checked ${wantedIds.size} payoutId(s), ${found.size} found in ledger.`);
    } catch (err) {
      console.warn(`  FAILED for ${merchantName}: ${err.message}`);
      skippedMerchants.push(merchantName);
    } finally {
      await context.close();
    }
  }
  await browser.close();

  const mismatches = results.filter((r) => r.refunded && !/refund|fail|revers|charge.?back/i.test(r.sheetStatus || ''));
  const notFoundInLedger = results.filter((r) => !r.found);

  console.log(`\n=== RESULTS ===`);
  console.log(`Checked: ${results.length} payoutId(s) across ${byMerchant.size - skippedMerchants.length}/${byMerchant.size} merchant(s).`);
  if (skippedMerchants.length) console.log(`Skipped merchants (no login / login failed): ${skippedMerchants.join(', ')}`);
  console.log(`Refunded on Paynix but sheet Status doesn't say so: ${mismatches.length}`);
  console.log(`PayoutIds from sheet not found at all in wallet ledger (unexpected): ${notFoundInLedger.length}`);

  if (mismatches.length) {
    console.log('\n--- STATUS MISMATCH (needs sheet update) ---');
    for (const r of mismatches) {
      console.log(`  Row ${r.rowNumber} | ${r.payoutId} | ${r.merchant} | sheet says "${r.sheetStatus}" | Paynix refunded Rs ${r.refundAmount.toFixed(2)}`);
    }
  }
  if (notFoundInLedger.length) {
    console.log('\n--- NOT FOUND IN WALLET LEDGER ---');
    for (const r of notFoundInLedger) {
      console.log(`  Row ${r.rowNumber} | ${r.payoutId} | ${r.merchant} | sheet says "${r.sheetStatus}"`);
    }
  }

  fs.writeFileSync('./data/_master-payout-status-check.json', JSON.stringify({ results, mismatches, notFoundInLedger, skippedMerchants }, null, 2));
  console.log('\nFull result saved to data/_master-payout-status-check.json');
}

run().catch((err) => { console.error(err); process.exit(1); });
