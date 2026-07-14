import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { fetchPreviousFromDrive } from './lib/drive-fetch.js';

const DATA_DIR = './data';
const RATES_FILE = path.join(DATA_DIR, 'commission-rates.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const MANUAL_TRANSACTIONS_FILE = path.join(DATA_DIR, 'manual-transactions.json');
const OUTPUT_JSON = path.join('./website', 'commission-results.json');
const RETENTION_DAYS = 30;

const { GOOGLE_DRIVE_RESULTS_FILE_ID, GOOGLE_DRIVE_API_KEY } = process.env;

// --- Column name guesses -------------------------------------------------
const COLUMN_ALIASES = {
  amount: ['amount', 'transaction amount', 'txn amount', 'payout amount'],
  status: ['status', 'transaction status', 'txn status'],
  date: ['date', 'transaction date', 'txn date', 'created at', 'processed at'],
  transactionId: ['transaction id', 'txn id', 'payout id', 'reference id'],
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

// PixlerPay report dates look like "9/7/2026, 12:37:47 pm" (D/M/YYYY).
function parseToISODate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  return null;
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

async function main() {
  const rates = JSON.parse(fs.readFileSync(RATES_FILE, 'utf-8'));
  const rateByName = new Map(rates.filter((r) => r.clientName).map((r) => [r.clientName.trim().toUpperCase(), r]));
  const rateByVa = new Map(rates.filter((r) => r.va).map((r) => [r.va, r]));

  const accounts = fs.existsSync(ACCOUNTS_FILE) ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8')) : [];
  const clientNameBySafeName = new Map(accounts.map((a) => [safeName(a.name), a.name]));

  const reportPaths = findAllReports();
  console.log(`Found ${reportPaths.length} report file(s):`, reportPaths.map((p) => path.basename(p)));

  // Fresh-scrape-only bookkeeping — used for idle-client detection (a
  // signal about THIS run's login/scrape health, not the merged history)
  // and to know what to merge into the persistent transaction log below.
  const freshPerClientSuccessCount = new Map();
  let skippedReports = [];
  const sourceReports = [];
  // Keyed by a stable transaction ID so merging against history is a
  // simple dedupe, not a fragile va+date+amount heuristic.
  const freshTransactionsById = new Map();

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
    if (!cols.transactionId) {
      console.warn(`[${clientName}] WARNING: no Transaction ID column found — merge/dedupe against history will be skipped for this client's rows this run.`);
    }

    let successCount = 0;
    for (const row of rows) {
      if (!isSuccessful(row[cols.status])) continue;
      const amount = Number(row[cols.amount]) || 0;
      const isoDate = cols.date ? parseToISODate(row[cols.date]) : null;
      const txnId = cols.transactionId ? String(row[cols.transactionId] || '') : '';
      successCount += 1;

      if (!txnId) continue; // can't safely merge/dedupe without a stable ID — drop rather than risk double-counting
      freshTransactionsById.set(txnId, [rate.va, isoDate, amount, txnId]);
    }
    freshPerClientSuccessCount.set(clientName, successCount);
  }

  // Manual entries for clients whose automation can't currently run (e.g.
  // a broken portal scrape) — see data/manual-transactions.json. Given a
  // synthetic stable ID (clientName+date+amount) so they dedupe correctly
  // on merge instead of re-adding themselves as a "new" transaction every run.
  const manualEntries = fs.existsSync(MANUAL_TRANSACTIONS_FILE)
    ? JSON.parse(fs.readFileSync(MANUAL_TRANSACTIONS_FILE, 'utf-8'))
    : [];
  for (const entry of manualEntries) {
    const rate = rateByName.get(entry.clientName.trim().toUpperCase());
    if (!rate || rate.onboardedPct == null || rate.resellerPct == null) {
      console.warn(`[manual entry: ${entry.clientName}] SKIPPED: no usable commission rate found in commission-rates.json`);
      continue;
    }
    const txnId = `manual|${entry.clientName}|${entry.date}|${entry.amount}`;
    freshTransactionsById.set(txnId, [rate.va, entry.date, entry.amount, txnId]);
    console.log(`[manual entry: ${entry.clientName}] Rs ${entry.amount} on ${entry.date}`);
  }

  // --- Merge against the previously published snapshot -------------------
  // GitHub Actions runners have no memory between runs, so "previous" comes
  // from the last snapshot published to Drive (same fallback pattern used
  // elsewhere in this project for diffing). Falls back to the local file on
  // disk for local dev runs where Drive isn't configured.
  let previous = await fetchPreviousFromDrive(GOOGLE_DRIVE_RESULTS_FILE_ID, GOOGLE_DRIVE_API_KEY);
  if (!previous && fs.existsSync(OUTPUT_JSON)) {
    try { previous = JSON.parse(fs.readFileSync(OUTPUT_JSON, 'utf-8')); } catch { /* ignore corrupt local file */ }
  }

  const mergedById = new Map();
  if (previous?.transactions) {
    for (const t of previous.transactions) {
      // Older snapshots (pre-migration) are 3-tuples [va, isoDate, amount]
      // with no stable ID — these can't be deduped against a fresh
      // re-scrape of the same window, so rather than risk double-counting
      // (a real bug hit here: an untagged previous snapshot merged with a
      // same-window fresh scrape ~doubled the transaction count), they're
      // dropped once the fresh scrape's own window already covers the
      // full retention period, which it does by default (see
      // download-report.js's 30-day default == RETENTION_DAYS below).
      const [va, isoDate, amount, txnId] = t;
      if (!txnId) continue;
      mergedById.set(txnId, [va, isoDate, amount, txnId]);
    }
  }
  for (const [txnId, t] of freshTransactionsById) {
    mergedById.set(txnId, t); // fresh data wins on conflict (should be identical anyway)
  }

  // --- Prune anything older than the retention window ---------------------
  const cutoffISO = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const prunedTransactions = Array.from(mergedById.values()).filter((t) => {
    const isoDate = t[1];
    return !isoDate || isoDate >= cutoffISO; // keep undated rows rather than silently drop them
  });

  // --- Recompute all aggregates from the merged + pruned transaction log --
  const perClient = new Map();
  let totalSuccessfulTxns = 0;
  let totalCommission = 0;
  for (const [va, isoDate, amount] of prunedTransactions) {
    const rate = rateByVa.get(va);
    if (!rate) continue;
    const result = calculateCommission(amount, rate);
    if (!result) continue;

    totalSuccessfulTxns += 1;
    totalCommission += result.commission;

    if (!perClient.has(va)) {
      perClient.set(va, {
        clientName: rate.clientName,
        va,
        onboardedPct: rate.onboardedPct,
        resellerPct: rate.resellerPct,
        onboardedFlat100to200: rate.onboardedFlat100to200,
        resellerFlat100to200: rate.resellerFlat100to200,
        marginPct: Math.round((rate.onboardedPct - rate.resellerPct) * 100) / 100,
        successfulTxns: 0,
        totalAmount: 0,
        totalCommission: 0,
      });
    }
    const agg = perClient.get(va);
    agg.successfulTxns += 1;
    agg.totalAmount += amount;
    agg.totalCommission += result.commission;
  }

  // Idle clients: had a report scraped THIS run (so the login worked, not a
  // skipped/broken account) but zero successful transactions in it — a
  // signal about this run's scrape health, not the 30-day merged history.
  const idleClients = accounts
    .map((a) => a.name)
    .filter((name) => {
      const rate = rateByName.get(name.trim().toUpperCase());
      if (!rate || rate.status !== 'Active') return false;
      const count = freshPerClientSuccessCount.get(name);
      return count == null || count === 0;
    });

  const results = {
    generatedAt: new Date().toISOString(),
    sourceReports,
    skippedReports,
    idleClients,
    totalSuccessfulTxns,
    totalCommission: Math.round(totalCommission * 100) / 100,
    clients: Array.from(perClient.values())
      .map((c) => ({ ...c, totalAmount: Math.round(c.totalAmount * 100) / 100, totalCommission: Math.round(c.totalCommission * 100) / 100 }))
      .sort((a, b) => b.totalCommission - a.totalCommission),
    // Per-transaction log: [va, isoDate, amount, transactionId]. Lets the
    // dashboard recompute totals for any custom date range client-side, and
    // lets the next run merge/dedupe against this snapshot.
    transactions: prunedTransactions,
  };

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));
  console.log(`\nCommission results written to ${OUTPUT_JSON}`);
  console.log(`Merged transaction log: ${mergedById.size} total, ${prunedTransactions.length} within ${RETENTION_DAYS}-day retention window (cutoff ${cutoffISO}).`);
  console.log(`Total successful transactions: ${totalSuccessfulTxns}, Total commission: Rs ${results.totalCommission}`);
  if (skippedReports.length > 0) {
    console.warn(`Skipped ${skippedReports.length} report(s) due to missing rate/columns:`, skippedReports);
  }
}

main();
