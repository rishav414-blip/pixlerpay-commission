// One-off: fetches full payout history for a fixed date range from each of
// the 9 known Paynix merchant portals, same API technique as
// download-paynix-merchant-reports.js but with an explicit range instead of
// the rolling FETCH_WINDOW_DAYS. Used for the Paynix commission cross-check
// report — not part of the regular npm run all pipeline.
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const MERCHANT_LOGIN_URL = 'https://merchant.paynix.co.in/auth/login';
const LOGINS_FILE = path.join('./data', 'paynix-merchant-logins.json');
const OUT_DIR = process.argv[4] || './data/paynix-merchant-reports-range';

const FROM = process.argv[2]; // YYYY-MM-DD
const TO = process.argv[3]; // YYYY-MM-DD
if (!FROM || !TO) {
  console.error('Usage: node fetch-merchant-payouts-range.mjs <FROM> <TO> [outDir]');
  process.exit(1);
}

const { PAYNIX_HEADFUL } = process.env;
const headless = PAYNIX_HEADFUL !== 'true';

async function fetchPayouts(page, fromDate, toDate) {
  return page.evaluate(async ({ fromDate, toDate }) => {
    const token = localStorage.getItem('paynix_access_token');
    const headers = { Authorization: `Bearer ${token}` };
    const perPage = 500;
    let pageNum = 1;
    const payouts = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    while (true) {
      const url = `https://api.paynix.co.in/api/v1/merchant/portal/transactions/payouts?page=${pageNum}&per_page=${perPage}&from=${fromDate}&to=${toDate}`;
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
      if (pageNum > 100) break;
    }
    return { payouts };
  }, { fromDate, toDate });
}

async function run() {
  const logins = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf-8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Fetching payouts from ${FROM} to ${TO} for ${logins.length} merchant(s)...`);

  const browser = await chromium.launch({ headless });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let successCount = 0;
  for (const [i, login] of logins.entries()) {
    if (i > 0) await sleep(1500);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      console.log(`Logging into ${login.merchantName} (${login.merchantId})...`);
      await page.goto(MERCHANT_LOGIN_URL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('textbox', { name: 'Email address' }).fill(login.username);
      await page.getByRole('textbox', { name: 'Password' }).fill(login.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForTimeout(3000);
      await page.goto('https://merchant.paynix.co.in/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);

      const result = await fetchPayouts(page, FROM, TO);
      if (result.error) throw new Error(`API error: ${JSON.stringify(result.error)}`);

      const payouts = result.payouts;
      const success = payouts.filter((p) => String(p.status).toUpperCase() === 'SUCCESS');
      const outFile = path.join(OUT_DIR, `${login.merchantId}.json`);
      fs.writeFileSync(outFile, JSON.stringify({
        merchantId: login.merchantId,
        merchantName: login.merchantName,
        scrapedAt: new Date().toISOString(),
        fetchWindow: { from: FROM, to: TO },
        totalPayouts: payouts.length,
        successCount: success.length,
        payouts,
      }, null, 2));
      console.log(`  -> ${payouts.length} payouts (${success.length} success), saved to ${outFile}`);
      successCount++;
    } catch (err) {
      console.warn(`  FAILED for ${login.merchantName}: ${err.message}`);
    } finally {
      await context.close();
    }
  }
  await browser.close();
  console.log(`\nDone: ${successCount}/${logins.length} merchant report(s) fetched.`);
}

run().catch((err) => { console.error(err); process.exit(1); });
