import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const DATA_DIR = './data';
const RATES_FILE = path.join(DATA_DIR, 'commission-rates.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const OUTPUT_JSON = path.join('./website', 'commission-results.json');

// --- Column name guesses -------------------------------------------------
const COLUMN_ALIASES = {
  amount: ['amount', 'transaction amount', 'txn amount', 'payout amount'],
  status: ['status', 'transaction status', 'txn status'],
  date: ['date', 'transaction date', 'txn date', 'created at', 'processed at'],
};

function findAllReports() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => /\.(csv|xlsx|xls)$/i.test(f));
  if (files.length === 0) {
    throw new Error(`No report files found in ${DATA_DIR}. Run "npm run download-report" first, or drop report files there manually.`);
  }
  return files.map((f) => path.join(DATA_DIR, f));
}

// Each report belongs to exactly one account/client (one login per report),
// so there is no per-row VA/client column to match against. The report's
// filename maps back to the account name used to download it.
function accountNameFromFile(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/^(.*?)-payout-report/i);
  return match ? match[1] : base;
}

function safeName(name) {
  return name.replace(/[^a-z0-9]+/gi, '-');
}

function loadReportRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function matchColumn(headers, aliases) {
  const lowerHeaders = headers.map((h) => h.toLowerCase().trim());
  for (const alias of aliases) {
    const idx = lowerHeaders.indexOf(alias);
    if (idx !== -1) return headers[idx];
  }
  return null;
}

function resolveColumns(rows) {
  const headers = Object.keys(rows[0]);
  const resolved = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    resolved[key] = matchColumn(headers, aliases);
  }
  return resolved;
}

function isSuccessful(statusValue) {
  if (!statusValue) return false;
  const s = String(statusValue).trim().toLowerCase();
  return ['success', 'successful', 'completed', 'paid', 'settled'].includes(s);
}

// Commission = margin = Onboarded pricing - Reseller pricing.
function calculateCommission(amount, rate) {
  if (!rate || rate.onboardedPct == null || rate.resellerPct == null) return null;
  if (
    amount >= 100 && amount <= 200 &&
    rate.onboardedFlat100to200 != null && rate.resellerFlat100to200 != null
  ) {
    return { commission: rate.onboardedFlat100to200 - rate.resellerFlat100to200, basis: 'flat_100_200_margin' };
  }
  const marginPct = rate.onboardedPct - rate.resellerPct;
  return { commission: (amount * marginPct) / 100, basis: 'percent_margin' };
}

function main() {
  const rates = JSON.parse(fs.readFileSync(RATES_FILE, 'utf-8'));
  const rateByName = new Map(rates.filter((r) => r.clientName).map((r) => [r.clientName.trim().toUpperCase(), r]));

  const accounts = fs.existsSync(ACCOUNTS_FILE) ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8')) : [];
  const clientNameBySafeName = new Map(accounts.map((a) => [safeName(a.name), a.name]));

  const reportPaths = findAllReports();
  console.log(`Found ${reportPaths.length} report file(s):`, reportPaths.map((p) => path.basename(p)));

  const perClient = new Map();
  let totalSuccessfulTxns = 0;
  let totalCommission = 0;
  let skippedReports = [];
  const sourceReports = [];

  for (const reportPath of reportPaths) {
    const fileAccountKey = accountNameFromFile(reportPath);
    const clientName = clientNameBySafeName.get(fileAccountKey) || fileAccountKey;
    sourceReports.push(path.basename(reportPath));

    const rate = rateByName.get(clientName.trim().toUpperCase());
    if (!rate || rate.onboardedPct == null || rate.resellerPct == null) {
      console.warn(`[${clientName}] SKIPPED: no usable commission rate found in commission-rates.json`);
      skippedReports.push(clientName);
      continue;
    }

    const rows = loadReportRows(reportPath);
    if (rows.length === 0) {
      console.warn(`[${clientName}] Report has 0 rows (no transactions in the selected date range) — skipping.`);
      continue;
    }

    const cols = resolveColumns(rows);
    if (!cols.amount || !cols.status) {
      console.warn(`[${clientName}] WARNING: Could not auto-detect amount/status columns. Headers found:`, Object.keys(rows[0]));
      console.warn('Update COLUMN_ALIASES in scripts/calculate-commission.js accordingly.');
      skippedReports.push(clientName);
      continue;
    }

    if (!perClient.has(clientName)) {
      perClient.set(clientName, {
        clientName,
        va: rate.va,
        onboardedPct: rate.onboardedPct,
        resellerPct: rate.resellerPct,
        marginPct: Math.round((rate.onboardedPct - rate.resellerPct) * 100) / 100,
        successfulTxns: 0,
        totalAmount: 0,
        totalCommission: 0,
      });
    }
    const agg = perClient.get(clientName);

    for (const row of rows) {
      if (!isSuccessful(row[cols.status])) continue;
      const amount = Number(row[cols.amount]) || 0;
      const result = calculateCommission(amount, rate);
      if (!result) continue;

      totalSuccessfulTxns += 1;
      totalCommission += result.commission;
      agg.successfulTxns += 1;
      agg.totalAmount += amount;
      agg.totalCommission += result.commission;
    }
  }

  const results = {
    generatedAt: new Date().toISOString(),
    sourceReports,
    skippedReports,
    totalSuccessfulTxns,
    totalCommission: Math.round(totalCommission * 100) / 100,
    clients: Array.from(perClient.values())
      .map((c) => ({ ...c, totalAmount: Math.round(c.totalAmount * 100) / 100, totalCommission: Math.round(c.totalCommission * 100) / 100 }))
      .sort((a, b) => b.totalCommission - a.totalCommission),
  };

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));
  console.log(`\nCommission results written to ${OUTPUT_JSON}`);
  console.log(`Total successful transactions: ${totalSuccessfulTxns}, Total commission: Rs ${results.totalCommission}`);
  if (skippedReports.length > 0) {
    console.warn(`Skipped ${skippedReports.length} report(s) due to missing rate/columns:`, skippedReports);
  }
}

main();
