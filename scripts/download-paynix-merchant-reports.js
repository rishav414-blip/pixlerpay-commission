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

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
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
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      console.log(`Logging into ${login.merchantName} (${login.merchantId})...`);
      await page.goto(MERCHANT_LOGIN_URL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('textbox', { name: 'Email address' }).fill(login.username);
      await page.getByRole('textbox', { name: 'Password' }).fill(login.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForTimeout(3000);
      // Need to be on a page under the app's origin for localStorage
      // (holding the access token) to be readable by page.evaluate.
      await page.goto('https://merchant.paynix.co.in/dashboard', { waitUntil: 'domcontentloaded' });
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
      await context.close();
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
