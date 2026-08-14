// One-off (not part of `npm run all`) — logs into each of the 18 PixlerPay
// merchant accounts and reads the "Wallet Balance" badge shown top-right on
// https://pixlerpay.com/merchant/dashboard after login. The PixlerPay tab's
// regular pipeline (download-report.js) never scrapes this — it only
// exports payout reports for commission calc — so this exists purely for
// ad-hoc "what's the current wallet balance" checks, run manually:
//
//   node scripts/check-pixlerpay-wallets.mjs
//
// Writes wallet-check-results.json (gitignored-by-convention working file,
// same as other data/*.json outputs) with the raw badge text per account.
import { chromium } from 'playwright';
import fs from 'node:fs';

const LOGIN_URL = 'https://pixlerpay.com/auth/merchant-login';
const accounts = JSON.parse(fs.readFileSync('./data/accounts.json', 'utf-8'));

const browser = await chromium.launch({ headless: true });
const results = [];

for (const { name, username, password } of accounts) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: 'Email Address' }).fill(username);
    await page.getByRole('textbox', { name: 'Password' }).fill(password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL('**/merchant/dashboard', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // The badge is a small "Wallet Balance" label with the amount in a
    // sibling element right below it — grabbing the parent's innerText and
    // stripping the label is simpler than chasing a specific CSS selector,
    // which isn't documented anywhere and could change without notice.
    const balanceText = await page.locator('text=Wallet Balance').first()
      .locator('xpath=..').innerText().catch(() => null);

    console.log(`[${name}] ${balanceText ? balanceText.replace(/\n/g, ' ') : 'FAILED to read balance'}`);
    results.push({ name, raw: balanceText, ok: true });
  } catch (err) {
    console.log(`[${name}] FAILED: ${err.message}`);
    results.push({ name, ok: false, error: err.message });
  } finally {
    await context.close();
  }
}

await browser.close();
fs.writeFileSync('./wallet-check-results.json', JSON.stringify(results, null, 2));
console.log('\nDone. Full results written to wallet-check-results.json');
