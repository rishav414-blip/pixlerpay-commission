import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toISO(d);
}

// CLI flags: --days=N, --from=YYYY-MM-DD, --to=YYYY-MM-DD
// e.g. npm run download-report -- --days=7
// e.g. npm run download-report -- --from=2026-06-01 --to=2026-06-30
const cliArgs = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [key, value] = a.slice(2).split('=');
      return [key, value];
    })
);

const {
  PIXLERPAY_LOGIN_URL = 'https://pixlerpay.com/auth/merchant-login',
  PIXLERPAY_HEADFUL,
  DOWNLOAD_DIR = './data',
  REPORT_DAYS,
  DATE_FROM,
  DATE_TO,
} = process.env;

// Priority: CLI flags > explicit DATE_FROM/DATE_TO env > REPORT_DAYS (last N days) env > default 30 days.
const days = cliArgs.days || REPORT_DAYS;
const dateFrom = cliArgs.from || DATE_FROM;
const dateTo = cliArgs.to || DATE_TO;

const resolvedDateTo = dateTo || toISO(new Date());
const resolvedDateFrom = dateFrom || daysAgoISO(Number(days) > 0 ? Number(days) - 1 : 29);

const ACCOUNTS_FILE = path.join(DOWNLOAD_DIR, 'accounts.json');

if (!fs.existsSync(ACCOUNTS_FILE)) {
  console.error(`Missing ${ACCOUNTS_FILE}. Copy data/accounts.example.json to data/accounts.json and fill in each merchant login's real username/password.`);
  process.exit(1);
}

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
if (!Array.isArray(accounts) || accounts.length === 0) {
  console.error('data/accounts.json must be a non-empty array of { name, username, password }.');
  process.exit(1);
}

const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const ARCHIVE_DIR = path.join(DOWNLOAD_DIR, 'raw-reports', RUN_TIMESTAMP);

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

const headless = PIXLERPAY_HEADFUL !== 'true';

async function downloadForAccount(browser, account) {
  const { name, username, password } = account;
  console.log(`\n=== [${name}] Logging in as ${username} ===`);

  // Preventive, same reasoning as download-paynix-merchant-wallets.js —
  // pin timezone so any client-rendered date on PixlerPay's own portal
  // isn't silently UTC-shifted on GitHub Actions runners.
  const context = await browser.newContext({ acceptDownloads: true, timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();

  await page.goto(PIXLERPAY_LOGIN_URL, { waitUntil: 'domcontentloaded' });

  // --- LOGIN STEP -----------------------------------------------------
  await page.getByRole('textbox', { name: 'Email Address' }).fill(username);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  console.log(`[${name}] Logged in. Navigating to payout transactions...`);

  // --- NAVIGATE TO PAYOUT REPORT, FILTER TO SUCCESSFUL ------------------
  await page.getByRole('link', { name: 'Payouts Transaction' }).click();
  await page.locator('#statusFilter').selectOption('success');
  await page.locator('#dateFrom').fill(resolvedDateFrom);
  await page.locator('#dateTo').fill(resolvedDateTo);
  await page.getByRole('button', { name: 'Apply Filters' }).click();

  console.log(`[${name}] Filtered to status=success, ${resolvedDateFrom} to ${resolvedDateTo}. Exporting...`);

  // --- TRIGGER DOWNLOAD -------------------------------------------------
  // CSV generation time scales with row count, so allow a generous timeout
  // and retry once if the download event doesn't fire in time.
  let download;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60000 }),
        page.getByRole('button', { name: 'Export CSV' }).click(),
      ]);
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`[${name}] Export timed out, retrying (attempt ${attempt + 1})...`);
    }
  }

  const suggested = download.suggestedFilename();
  const ext = path.extname(suggested) || '.csv';
  const safeName = name.replace(/[^a-z0-9]+/gi, '-');

  // "Latest" copy — this is what calculate-commission.js reads.
  const savePath = path.join(DOWNLOAD_DIR, `${safeName}-payout-report${ext}`);
  await download.saveAs(savePath);

  // Archived copy — kept for manual verification, never overwritten.
  const archivePath = path.join(ARCHIVE_DIR, `${safeName}-payout-report${ext}`);
  fs.copyFileSync(savePath, archivePath);

  console.log(`[${name}] Payout report saved to: ${savePath}`);
  console.log(`[${name}] Archived copy: ${archivePath}`);

  await context.close();
  return savePath;
}

async function run() {
  const browser = await chromium.launch({ headless });
  const saved = [];

  for (const account of accounts) {
    try {
      const savePath = await downloadForAccount(browser, account);
      saved.push({ account: account.name, savePath, ok: true });
    } catch (err) {
      console.error(`[${account.name}] FAILED:`, err.message);
      saved.push({ account: account.name, ok: false, error: err.message });
    }
  }

  await browser.close();

  console.log('\n=== Summary ===');
  for (const s of saved) {
    console.log(s.ok ? `OK   ${s.account} -> ${s.savePath}` : `FAIL ${s.account}: ${s.error}`);
  }

  const failed = saved.filter((s) => !s.ok);
  if (failed.length > 0) {
    console.warn(`\n${failed.length} of ${saved.length} account(s) failed — continuing with the rest.`);
  }
  // Exit non-zero only if EVERY account failed. A single known-broken
  // client (e.g. N V CONNECT ACROSS's mismatched portal layout) shouldn't
  // fail the whole `npm run all` chain and block every downstream step —
  // that's especially costly in CI, where a single perpetually-broken
  // client would otherwise block every scheduled run forever.
  if (failed.length === saved.length && saved.length > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Automation failed:', err);
  process.exit(1);
});
