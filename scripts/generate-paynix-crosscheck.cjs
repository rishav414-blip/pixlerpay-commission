// Builds the Paynix commission cross-check report: for each merchant with a
// portal login, compares our own calculated margin commission per SUCCESS
// payout against what Paynix actually credited (matched via the reseller
// wallet ledger's COMMISSION entries, referenceId === payoutId).
//
// Inputs (produced by fetch-merchant-payouts-range.mjs and
// fetch-reseller-ledger-range.mjs for the same date range):
//   data/paynix-merchant-reports-range/<merchantId>.json
//   data/reseller-ledger-<range>.json
// Rate card: data/paynix-commission-rates.json (same as calculate-paynix-commission.js)
//
// Commission formula mirrors calculate-paynix-commission.js exactly (flat
// band below Rs1000, percentage margin above) — keep in sync if that
// script's logic changes.
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const [, , FROM, TO, REPORTS_DIR, LEDGER_FILE, OUT_PATH] = process.argv;
if (!FROM || !TO || !REPORTS_DIR || !LEDGER_FILE || !OUT_PATH) {
  console.error('Usage: node generate-paynix-crosscheck.cjs <FROM> <TO> <reportsDir> <ledgerFile> <outPath>');
  process.exit(1);
}

function calcMarginCommission(amount, rate) {
  if (amount <= 1000 && rate.onboardedFlatBelow1000 != null && rate.resellerFlatBelow1000 != null) {
    return rate.onboardedFlatBelow1000 - rate.resellerFlatBelow1000;
  }
  return (amount * (rate.onboardedPct - rate.resellerPct)) / 100;
}

// Paynix merchant export dates look like "9/7/2026, 12:37:47 pm" (D/M/YYYY) —
// mirrors parseToISODate in calculate-paynix-commission.js.
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

// Mirrors resolveRateForDate in calculate-paynix-commission.js — keep in sync.
function resolveRateForDate(rate, isoDate) {
  if (!rate.rateHistory || !rate.rateHistory.length) return rate;
  const applicable = rate.rateHistory
    .filter((h) => !h.effectiveFrom || !isoDate || h.effectiveFrom <= isoDate)
    .sort((a, b) => (a.effectiveFrom || '').localeCompare(b.effectiveFrom || ''));
  const chosen = applicable[applicable.length - 1] || rate.rateHistory[0];
  return { ...rate, ...chosen };
}

function isSuccess(status) {
  return String(status || '').trim().toUpperCase() === 'SUCCESS';
}

function fmtIST(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(',', '');
}

async function main() {
  const rates = JSON.parse(fs.readFileSync('./data/paynix-commission-rates.json', 'utf-8'));
  const rateByMerchant = new Map(rates.filter((r) => r.merchantId).map((r) => [r.merchantId, r]));

  const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'));
  const commissionEntries = ledger.filter((e) => e.category === 'COMMISSION' && e.referenceType === 'PAYOUT_TXN' && e.referenceId);
  const ledgerByPayoutId = new Map(commissionEntries.map((e) => [e.referenceId, e]));

  const reportFiles = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json'));

  const wb = new ExcelJS.Workbook();
  const summarySheet = wb.addWorksheet('Summary');
  const txnSheet = wb.addWorksheet('All Transactions');
  const ledgerSheet = wb.addWorksheet('Paynix Wallet Ledger (raw)');

  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  const thinBorder = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

  function styleHeader(row) {
    row.eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = { bold: true };
      cell.border = thinBorder;
      cell.alignment = { wrapText: true, vertical: 'middle' };
    });
  }

  // ---- Summary sheet ----
  summarySheet.columns = [
    { header: '', key: 'pad', width: 2 },
    { header: 'Merchant', key: 'merchant', width: 32 },
    { header: 'Merchant ID', key: 'merchantId', width: 18 },
    { header: 'Our SUCCESS Payouts', key: 'ourCount', width: 16 },
    { header: 'Matched to Wallet Ledger', key: 'matchedCount', width: 18 },
    { header: 'Not Given by Paynix', key: 'unmatchedCount', width: 16 },
    { header: 'Match %', key: 'matchPct', width: 10 },
    { header: 'Matched Volume (Rs)', key: 'matchedVolume', width: 16 },
    { header: 'Unmatched Volume (Rs)', key: 'unmatchedVolume', width: 16 },
    { header: 'Our Commission (matched txns)', key: 'ourCommissionMatched', width: 18 },
    { header: 'Our Commission (unmatched txns)', key: 'ourCommissionUnmatched', width: 18 },
    { header: 'Paynix Wallet Commission (matched txns)', key: 'paynixCommission', width: 20 },
  ];
  styleHeader(summarySheet.getRow(1));

  const allTxnRows = [];
  const summaryRows = [];

  for (const rate of rates) {
    if (!rate.merchantId) continue;
    const reportFile = path.join(REPORTS_DIR, `${rate.merchantId}.json`);
    if (!fs.existsSync(reportFile)) continue; // no portal login — skip, not fabricated as zero
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
    const successPayouts = report.payouts.filter((p) => isSuccess(p.status) && p.payoutId);

    let matchedCount = 0, unmatchedCount = 0, matchedVolume = 0, unmatchedVolume = 0;
    let ourCommissionMatched = 0, ourCommissionUnmatched = 0, paynixCommission = 0;

    for (const p of successPayouts) {
      const ledgerEntry = ledgerByPayoutId.get(p.payoutId);
      const effRate = resolveRateForDate(rate, parseToISODate(p.createdAt));
      const ourCommission = Math.round(calcMarginCommission(p.amount, effRate) * 100) / 100;
      const matched = !!ledgerEntry;
      if (matched) {
        matchedCount++;
        matchedVolume += p.amount;
        ourCommissionMatched += ourCommission;
        paynixCommission += ledgerEntry.amount;
      } else {
        unmatchedCount++;
        unmatchedVolume += p.amount;
        ourCommissionUnmatched += ourCommission;
      }

      allTxnRows.push([
        rate.clientName, rate.merchantId, p.payoutId, p.amount, fmtIST(p.createdAt),
        ourCommission,
        matched ? ledgerEntry.amount : null,
        matched ? Math.round((ourCommission - ledgerEntry.amount) * 100) / 100 : null,
        matched ? 'Matched' : 'Not given by Paynix',
        matched ? fmtIST(ledgerEntry.createdAt) : null,
      ]);
    }

    summaryRows.push([
      rate.clientName, rate.merchantId, successPayouts.length, matchedCount, unmatchedCount,
      successPayouts.length ? Math.round((matchedCount / successPayouts.length) * 10000) / 100 : 0,
      Math.round(matchedVolume * 100) / 100, Math.round(unmatchedVolume * 100) / 100,
      Math.round(ourCommissionMatched * 100) / 100, Math.round(ourCommissionUnmatched * 100) / 100,
      Math.round(paynixCommission * 100) / 100,
    ]);
  }

  for (const row of summaryRows) {
    const r = summarySheet.addRow([null, ...row]);
    r.eachCell({ includeEmpty: true }, (cell) => { cell.border = thinBorder; });
  }

  // ---- All Transactions sheet ----
  txnSheet.columns = [
    { header: '', key: 'pad', width: 2 },
    { header: 'Merchant', key: 'merchant', width: 32 },
    { header: 'Merchant ID', key: 'merchantId', width: 18 },
    { header: 'Payout ID', key: 'payoutId', width: 24 },
    { header: 'Amount (Rs)', key: 'amount', width: 12 },
    { header: 'Payout Created At', key: 'createdAt', width: 20 },
    { header: 'Our Calculated Commission (Rs)', key: 'ourCommission', width: 18 },
    { header: 'Paynix Credited Commission (Rs)', key: 'paynixCommission', width: 18 },
    { header: 'Diff (Ours - Paynix)', key: 'diff', width: 14 },
    { header: 'Match Status', key: 'status', width: 18 },
    { header: 'Paynix Credit Created At', key: 'creditCreatedAt', width: 20 },
  ];
  styleHeader(txnSheet.getRow(1));
  for (const row of allTxnRows) {
    const r = txnSheet.addRow([null, ...row]);
    r.eachCell({ includeEmpty: true }, (cell) => { cell.border = thinBorder; });
  }

  // ---- Ledger raw sheet ----
  ledgerSheet.columns = [
    { header: '', key: 'pad', width: 2 },
    { header: 'Category', key: 'category', width: 14 },
    { header: 'Reference ID', key: 'referenceId', width: 24 },
    { header: 'Amount (Rs)', key: 'amount', width: 12 },
    { header: 'Created At', key: 'createdAt', width: 26 },
  ];
  styleHeader(ledgerSheet.getRow(1));
  for (const e of commissionEntries) {
    const r = ledgerSheet.addRow([null, e.category, e.referenceId, e.amount, e.createdAt]);
    r.eachCell({ includeEmpty: true }, (cell) => { cell.border = thinBorder; });
  }

  await wb.xlsx.writeFile(OUT_PATH);
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Range: ${FROM} to ${TO}`);
  console.log(`Merchants covered: ${summaryRows.length}, total transactions: ${allTxnRows.length}, ledger COMMISSION entries: ${commissionEntries.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
