// Fetches RECENT payouts (not full lifetime history) from each of the
// known individual Paynix merchant portal accounts
// (data/paynix-merchant-logins.json — currently 9 of 13 rate-card clients;
// see HANDOFF.md limitation #7), via the portal's own authenticated JSON
// API rather than the xlsx Export button.
//
// Incremental fetch (2026-07-14): originally this exported each merchant's
// FULL lifetime payout history every run — some accounts have 9,000+
// payouts, making every run slow and wasteful when only a handful of new
// transactions exist since the last run. Switched to the direct API
// (`GET /merchant/portal/transactions/payouts?from=...&to=...`, confirmed
// working via manual date-filter UI testing on the payouts page — same
// underlying API the "Export" button and page pagination both use) with a
// FETCH_WINDOW_DAYS date range, paginated at per_page=500. This only pulls
// the recent window each run; calculate-paynix-commission.js merges it
// against the previously published snapshot (deduped by payoutId) and
// prunes anything older than 30 days, so the full rolling history is
// still reconstructed correctly across runs without re-fetching it.
//
// Deliberately does NOT attempt the 4 missing merchants (APAS TECH POINT,
// PPAY SOLUTION, Global Books Trading, Define Enterprises) — they're
// skipped and calculate-paynix-commission.js reports them as
// "no data available" rather than silently showing zero.

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { loginPaynixMerchant, getAuthenticatedContext } from './lib/paynix-merchant-login.js';

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
const MERCHANT_DASHBOARD_URL = 'https://merchant.paynix.co.in/dashboard';
// Same directory/keying as download-paynix-merchant-wallets.js — a session
// established by either script for a given merchant is reusable by the
// other, since both authenticate against the same merchant.paynix.co.in
// origin. See lib/paynix-merchant-login.js for why this exists.
const SESSIONS_DIR = path.join('./data', 'paynix-sessions');
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');
const REPORTS_DIR = path.join('./data', 'paynix-merchant-reports');

// A few days' overlap margin beyond the 15/30-min run cadence, so a missed
// run (CI delay, a merchant login failure, etc.) can't silently create a
// gap in the merged history — see calculate-paynix-commission.js's merge
// step, which dedupes by payoutId so re-fetching overlapping days is safe.
const FETCH_WINDOW_DAYS = Number(process.env.PAYNIX_MERCHANT_FETCH_WINDOW_DAYS) || 3;

const { PAYNIX_HEADFUL } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

async function fetchRecentPayouts(page, fromDate, toDate) {
  return page.evaluate(async ({ fromDate, toDate }) => {
    const token = localStorage.getItem('paynix_access_token');
    const headers = { Authorization: `Bearer ${token}` };
    const perPage = 500;
    let pageNum = 1;
    const payouts = [];
    while (true) {
      const url = `https://api.paynix.co.in/api/v1/merchant/portal/transactions/payouts?page=${pageNum}&per_page=${perPage}&from=${fromDate}&to=${toDate}`;
      const res = await fetch(url, { headers });
      const json = await res.json();
      if (!json.success) return { error: json };
      const batch = json.data || [];
      for (const t of batch) {
        payouts.push({
          payoutId: t.transaction_id || null,
          status: t.status || null,
          amount: Number(t.amount) || 0,
          createdAt: t.created_at || null,
        });
      }
      if (batch.length < perPage) break;
      pageNum += 1;
      if (pageNum > 40) break; // safety cap (40 * 500 = 20000 — far beyond any realistic 3-day window)
    }
    return { payouts };
  }, { fromDate, toDate });
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

  const fromDate = isoDaysAgo(FETCH_WINDOW_DAYS);
  const toDate = isoDaysAgo(0);
  console.log(`Fetching payouts from ${fromDate} to ${toDate} (${FETCH_WINDOW_DAYS}-day window) for ${logins.length} merchant(s)...`);

  const browser = await chromium.launch({ headless });
  let successCount = 0;
  for (const login of logins) {
    // context declared outside try, but *creation* (including performLogin,
    // which can throw on a login failure) happens inside — a login failure
    // for one merchant must fall through to the existing per-merchant catch
    // below, not crash the whole run. See download-paynix-merchant-wallets.js
    // for the regression this mirrors and was caught against.
    let context;
    try {
      const sessionFile = path.join(SESSIONS_DIR, `${login.merchantId}.json`);
      const authed = await getAuthenticatedContext(browser, {
        sessionFile,
        dashboardUrl: MERCHANT_DASHBOARD_URL,
        performLogin: (p) => loginPaynixMerchant(p, MERCHANT_LOGIN_URL, login.username, login.password),
        merchantLabel: login.merchantName,
      });
      if (authed.skipped) {
        // Backing off after a recent login failure — nothing to fetch this
        // cycle, existing report.json (if any) stays as the last known data.
        console.warn(`  Skipped ${login.merchantName} (backing off after recent failure).`);
        continue;
      }
      context = authed.context;
      const page = authed.page;
      console.log(`Logging into ${login.merchantName} (${login.merchantId})${authed.reused ? ' (reused session)' : ''}...`);
      // Need to be on a page under the app's origin for localStorage
      // (holding the access token) to be readable by page.evaluate — the
      // dashboard nav already happened inside getAuthenticatedContext
      // (either for the freshly-authenticated page or to verify the
      // restored session), so this is just the settle wait.
      await page.waitForTimeout(1500);

      const result = await fetchRecentPayouts(page, fromDate, toDate);
      if (result.error) throw new Error(`API error: ${JSON.stringify(result.error)}`);

      const payouts = result.payouts;
      const success = payouts.filter((p) => isSuccessful(p.status));
      const outFile = path.join(REPORTS_DIR, `${login.merchantId}.json`);
      fs.writeFileSync(outFile, JSON.stringify({
        merchantId: login.merchantId,
        merchantName: login.merchantName,
        scrapedAt: new Date().toISOString(),
        fetchWindow: { from: fromDate, to: toDate },
        totalPayouts: payouts.length,
        successCount: success.length,
        payouts,
      }, null, 2));
      console.log(`  -> ${payouts.length} payouts in window (${success.length} success), saved to ${outFile}`);
      successCount++;
    } catch (err) {
      console.warn(`  FAILED for ${login.merchantName}: ${err.message}`);
    } finally {
      if (context) await context.close();
    }
  }
  await browser.close();

  console.log(`\nDone: ${successCount}/${logins.length} merchant report(s) fetched.`);
  if (successCount < logins.length) {
    console.warn('Some merchants failed — their previous report.json (if any) stays as the last known data.');
  }
}

run().catch((err) => {
  console.error('Paynix merchant report fetch failed:', err);
  process.exit(1);
});
