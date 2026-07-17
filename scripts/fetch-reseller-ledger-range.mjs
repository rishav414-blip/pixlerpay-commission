// One-off: fetches the reseller portal's wallet transaction ledger
// (GET /reseller/portal/wallet/transactions), paginating backward from the
// most recent entry until createdAt drops below the requested `from` date,
// then filters to [from, to] inclusive. Used for the Paynix commission
// cross-check report — not part of the regular npm run all pipeline.
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';

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
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(PAYNIX_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Email address' }).fill(PAYNIX_USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).fill(PAYNIX_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForTimeout(3000);
  await page.goto('https://reseller.paynix.co.in/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const fromMs = new Date(FROM + 'T00:00:00.000Z').getTime();
  const toMs = new Date(TO + 'T23:59:59.999Z').getTime();

  const entries = await page.evaluate(async ({ fromMs, toMs }) => {
    const token = localStorage.getItem('paynix_access_token');
    const headers = { Authorization: `Bearer ${token}` };
    const perPage = 200;
    let pageNum = 1;
    const collected = [];
    while (true) {
      const url = `https://api.paynix.co.in/api/v1/reseller/portal/wallet/transactions?page=${pageNum}&per_page=${perPage}`;
      const res = await fetch(url, { headers });
      const json = await res.json();
      if (!json.success) return { error: json };
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
