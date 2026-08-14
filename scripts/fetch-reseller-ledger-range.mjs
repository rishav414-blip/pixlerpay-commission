// One-off: fetches the reseller portal's wallet transaction ledger
// (GET /reseller/portal/wallet/transactions), paginating backward from the
// most recent entry until createdAt drops below the requested `from` date,
// then filters to [from, to] inclusive. Used for the Paynix commission
// cross-check report — not part of the regular npm run all pipeline.
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { completePaynixLogin, getAuthenticatedContext } from './lib/paynix-merchant-login.js';

// Fixed 2026-08-14: this script predated Paynix's OTP rollout to the
// reseller portal (2026-08-10, see lib/paynix-merchant-login.js) and did
// a plain single-step email/password login with no OTP handling — every
// login silently landed back on /auth/login, and
// localStorage.getItem('paynix_access_token') returned null, surfacing
// as an opaque "Invalid or expired token" API error rather than a login
// failure. Switched to the same shared helper download-paynix.js already
// uses, including session reuse (this is a one-off local script, but
// reuse still avoids burning an OTP request if it's re-run).
const SESSION_FILE = path.join('./data', 'paynix-sessions', 'reseller.json');
const RESELLER_DASHBOARD_URL = 'https://reseller.paynix.co.in/dashboard';

const { PAYNIX_LOGIN_URL, PAYNIX_USERNAME, PAYNIX_PASSWORD } = process.env;
const FROM = process.argv[2]; // YYYY-MM-DD
const TO = process.argv[3]; // YYYY-MM-DD (inclusive)
const OUT = process.argv[4] || './data/reseller-ledger-range.json';

if (!FROM || !TO) {
  console.error('Usage: node fetch-reseller-ledger-range.mjs <FROM:YYYY-MM-DD> <TO:YYYY-MM-DD> [outFile]');
  process.exit(1);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const { page, reused } = await getAuthenticatedContext(browser, {
    sessionFile: SESSION_FILE,
    dashboardUrl: RESELLER_DASHBOARD_URL,
    performLogin: async (p) => {
      await p.goto(PAYNIX_LOGIN_URL, { waitUntil: 'domcontentloaded' });
      await completePaynixLogin(p, PAYNIX_USERNAME, PAYNIX_PASSWORD);
    },
    merchantLabel: 'Paynix reseller portal',
  });
  if (!page) {
    console.error('Login backed off after a recent failure (see data/paynix-sessions/reseller.failure.json) — try again later.');
    await browser.close();
    process.exit(1);
  }
  console.log(`Logged into reseller portal${reused ? ' (reused session)' : ''}.`);

  const fromMs = new Date(FROM + 'T00:00:00.000Z').getTime();
  const toMs = new Date(TO + 'T23:59:59.999Z').getTime();

  const entries = await page.evaluate(async ({ fromMs, toMs }) => {
    const token = localStorage.getItem('paynix_access_token');
    const headers = { Authorization: `Bearer ${token}` };
    const perPage = 200;
    let pageNum = 1;
    const collected = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    while (true) {
      const url = `https://api.paynix.co.in/api/v1/reseller/portal/wallet/transactions?page=${pageNum}&per_page=${perPage}`;
      let json;
      for (let attempt = 1; ; attempt++) {
        const res = await fetch(url, { headers });
        json = await res.json();
        if (json.success || json.error?.code !== 'RATE_LIMIT_EXCEEDED' || attempt >= 5) break;
        await sleep(attempt * 5000);
      }
      if (!json.success) return { error: json };
      await sleep(400);
      const batch = json.data || [];
      if (batch.length === 0) break;
      let allBelowFrom = true;
      for (const t of batch) {
        const created = new Date(t.createdAt).getTime();
        if (created >= fromMs && created <= toMs) {
          collected.push(t);
          allBelowFrom = false;
        } else if (created >= fromMs) {
          allBelowFrom = false;
        }
      }
      // list is sorted newest-first; once every row in a page is older than `from`, stop.
      if (allBelowFrom) break;
      if (!json.pagination?.has_next) break;
      pageNum += 1;
      if (pageNum > 5000) break; // safety cap
    }
    return { entries: collected };
  }, { fromMs, toMs });

  if (entries.error) {
    console.error('API error:', JSON.stringify(entries.error));
    process.exit(1);
  }

  fs.writeFileSync(OUT, JSON.stringify(entries.entries, null, 2));
  console.log(`Fetched ${entries.entries.length} ledger entries for ${FROM}..${TO}, saved to ${OUT}`);

  await browser.close();
}
run().catch((e) => { console.error(e); process.exit(1); });
