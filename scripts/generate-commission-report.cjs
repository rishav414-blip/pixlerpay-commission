// Generates a formatted PixlerPay commission Excel report for a given date
// range, matching the client's original rate-card sheet layout exactly
// (merged title, green header, yellow Commission column, bold Total row).
//
// Pulls live per-transaction data from the Drive-published snapshot (the
// same one the dashboard reads), NOT from local CSVs/JSON, since local
// files go stale between scrape runs. See HANDOFF.md "Periodic commission
// Excel report" section for full context.
//
// Usage:
//   node scripts/generate-commission-report.cjs <START:YYYY-MM-DD> <END:YYYY-MM-DD> [outputPath]
//
// Example (next 10-day cycle):
//   node scripts/generate-commission-report.cjs 2026-07-11 2026-07-20

const fs = require('fs');
const path = require('path');
const https = require('https');
const ExcelJS = require('exceljs');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const [, , startArg, endArg, outArg] = process.argv;
if (!startArg || !endArg) {
  console.error('Usage: node scripts/generate-commission-report.cjs <START:YYYY-MM-DD> <END:YYYY-MM-DD> [outputPath]');
  process.exit(1);
}
const START = startArg;
const END = endArg;

const DRIVE_FILE_ID = process.env.GOOGLE_DRIVE_RESULTS_FILE_ID;
const DRIVE_API_KEY = process.env.GOOGLE_DRIVE_API_KEY;
if (!DRIVE_FILE_ID || !DRIVE_API_KEY) {
  console.error('Missing GOOGLE_DRIVE_RESULTS_FILE_ID or GOOGLE_DRIVE_API_KEY in .env');
  process.exit(1);
}

const RATES_FILE = path.join(__dirname, '..', 'data', 'commission-rates.json');

// Client VAs present in the client's very first reference sheet ("Volume
// till 30th June"), used to flag any client added to commission-rates.json
// since then as "(New Client)" in the report. Update this set if the
// client re-baselines what counts as "already known".
const ORIGINAL_VAS = new Set([
  'SAM256', 'SAM262', 'SAM288', 'SAM295', 'SAM286', 'SAM294',
  'SAM349', 'SAM298', 'SAM299', 'SAM328', 'SAM348', 'SAM358', 'SAM353',
]);

function fetchLiveResults() {
  const url = `https://www.googleapis.com/drive/v3/files/${DRIVE_FILE_ID}?alt=media&key=${DRIVE_API_KEY}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Drive fetch failed: HTTP ${res.statusCode}`));
        return;
      }
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => resolve(JSON.parse(raw)));
    }).on('error', reject);
  });
}

// Same margin logic as scripts/calculate-commission.js: percentage margin
// on amount, EXCEPT a flat-rate override (onboardedFlat - resellerFlat)
// for transactions in the 100-200 band. Must stay in sync with that file.
function calcCommission(amount, r) {
  if (amount >= 100 && amount <= 200 && r.onboardedFlat100to200 != null && r.resellerFlat100to200 != null) {
    return r.onboardedFlat100to200 - r.resellerFlat100to200;
  }
  return (amount * (r.onboardedPct - r.resellerPct)) / 100;
}

// "Commission by client" / "NXT commission" — reverse-engineered from the
// client's own manually-edited report (2026-07-12). These are per-client
// assignments, not a blanket rule by onboarded-rate tier: only the
// specific clients that already had a value filled in that report get one
// here (same formula, same client) — every other client stays blank, even
// if their onboarded rate matches one of the tiers below. Confirmed by the
// client: treat exactly this per-client mapping as the formal rule.
//   Commission by client = volume x 0.20% (onboarded 1.30% clients) or
//                           volume x 0.10% (onboarded 1.10% clients)
//   NXT commission        = volume x 0.10% (onboarded 1.20% clients)
const COMMISSION_BY_CLIENT_VAS = new Set(['SAM255', 'SAM256', 'SAM288', 'SAM295']); // WESERV, SERVM, Emervex, Curiobyte
const NXT_COMMISSION_VAS = new Set(['SAM286', 'SAM298', 'SAM299', 'SAM328', 'SAM338', 'SAM348', 'SAM358']); // RASHEEYA, N V CONNECT, BITNEXY, GLOBAL BOOKS, SOSHY, PPAY, suvika

function calcSplitCommissions(va, volume, onboardedPct) {
  const pct = Math.round(onboardedPct * 100) / 100; // normalize float noise
  if (COMMISSION_BY_CLIENT_VAS.has(va)) {
    const rate = pct === 1.30 ? 0.002 : pct === 1.10 ? 0.001 : null;
    return { commissionByClient: rate != null ? volume * rate : null, nxtCommission: null };
  }
  if (NXT_COMMISSION_VAS.has(va)) {
    return { commissionByClient: null, nxtCommission: pct === 1.20 ? volume * 0.001 : null };
  }
  return { commissionByClient: null, nxtCommission: null };
}

async function main() {
  console.log(`Fetching live commission data from Drive (file ${DRIVE_FILE_ID})...`);
  const d = await fetchLiveResults();
  console.log(`Live data generatedAt: ${d.generatedAt}, ${d.transactions.length} total transactions`);

  const rates = JSON.parse(fs.readFileSync(RATES_FILE, 'utf-8'));
  const rateByVa = {};
  for (const r of rates) if (r.va) rateByVa[r.va] = r;

  const clientByVa = {};
  for (const c of d.clients) clientByVa[c.va] = c;

  const byVa = {};
  for (const [va, date, amount] of d.transactions) {
    if (date < START || date > END) continue;
    const r = rateByVa[va];
    if (!r) continue;
    if (!byVa[va]) byVa[va] = { amount: 0, count: 0, commission: 0 };
    byVa[va].amount += amount;
    byVa[va].count += 1;
    byVa[va].commission += calcCommission(amount, r);
  }

  if (Object.keys(byVa).length === 0) {
    console.warn(`WARNING: no transactions found in range ${START}..${END}. ` +
      `Latest available data is up to ${d.transactions.reduce((m, t) => (t[1] > m ? t[1] : m), '')}. ` +
      'Report will still be generated but will be empty.');
  }

  const dataRows = [];
  let sno = 1;
  for (const va of Object.keys(byVa).sort()) {
    const c = clientByVa[va] || {};
    const r = rateByVa[va] || {};
    const margin = Math.round((r.onboardedPct - r.resellerPct) * 100) / 100;
    let clientName = (c.clientName || r.clientName || '').trim();
    if (!ORIGINAL_VAS.has(va)) clientName += ' (New Client)';
    const volume = Math.round(byVa[va].amount * 100) / 100;
    const split = calcSplitCommissions(va, volume, r.onboardedPct);
    dataRows.push({
      sno: sno++,
      clientName,
      va,
      resellerPct: r.resellerPct,
      resellerFlat: r.resellerFlat100to200,
      onboardedPct: r.onboardedPct,
      onboardedFlat: r.onboardedFlat100to200,
      marginPct: margin,
      volume,
      commission: Math.round(byVa[va].commission * 100) / 100,
      commissionByClient: split.commissionByClient != null ? Math.round(split.commissionByClient * 100) / 100 : null,
      nxtCommission: split.nxtCommission != null ? Math.round(split.nxtCommission * 100) / 100 : null,
    });
  }

  const total = dataRows.reduce((s, r) => s + r.commission, 0);
  const totalByClient = dataRows.reduce((s, r) => s + (r.commissionByClient || 0), 0);
  const totalNxt = dataRows.reduce((s, r) => s + (r.nxtCommission || 0), 0);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Commission');

  const COLS = [
    { key: 'sno', width: 6 },
    { key: 'clientName', width: 42 },
    { key: 'va', width: 10 },
    { key: 'resellerPct', width: 12 },
    { key: 'resellerFlat', width: 12 },
    { key: 'onboardedPct', width: 12 },
    { key: 'onboardedFlat', width: 12 },
    { key: 'marginPct', width: 11 },
    { key: 'volume', width: 16 },
    { key: 'commission', width: 13 },
    { key: 'commissionByClient', width: 15 },
    { key: 'nxtCommission', width: 15 },
  ];
  ws.columns = COLS;

  const NUM_COLS = COLS.length;
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6E0B4' } };
  const COMMISSION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };

  const formatDateLabel = (iso) => {
    const [y, m, dd] = iso.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${parseInt(dd, 10)} ${months[parseInt(m, 10) - 1]}`;
  };
  const TITLE = `Volume ${formatDateLabel(START)} to ${formatDateLabel(END)}`;

  ws.mergeCells(1, 1, 1, NUM_COLS);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = TITLE;
  titleCell.font = { bold: true, size: 12 };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.border = allBorders;
  ws.getRow(1).height = 20;

  const headerLabels = [
    'S.NO.', 'Client Name', 'VA', 'Sumeet(reseller) Pricing', 'Sumeet(reseller) Pricing below 1000',
    'Onboarded Pricing', 'Onboarded Pricing for 100-200', 'Diff Pricing',
    `Volume Duration ${formatDateLabel(START)} to ${formatDateLabel(END)}`, 'Commission',
    'Commission by client', 'NXT commission ',
  ];
  const headerRow = ws.getRow(2);
  headerLabels.forEach((label, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = label;
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = allBorders;
  });
  headerRow.height = 45;

  let r = 3;
  for (const row of dataRows) {
    const excelRow = ws.getRow(r);
    excelRow.getCell(1).value = row.sno;
    excelRow.getCell(2).value = row.clientName;
    excelRow.getCell(3).value = row.va;
    excelRow.getCell(4).value = row.resellerPct != null ? row.resellerPct / 100 : null;
    excelRow.getCell(5).value = row.resellerFlat != null ? `Rs ${row.resellerFlat}` : '';
    excelRow.getCell(6).value = row.onboardedPct != null ? row.onboardedPct / 100 : null;
    excelRow.getCell(7).value = row.onboardedFlat != null ? `Rs ${row.onboardedFlat}` : '';
    excelRow.getCell(8).value = row.marginPct != null ? row.marginPct / 100 : null;
    excelRow.getCell(9).value = row.volume;
    excelRow.getCell(10).value = row.commission;
    excelRow.getCell(11).value = row.commissionByClient;
    excelRow.getCell(12).value = row.nxtCommission;

    excelRow.getCell(4).numFmt = '0.00%';
    excelRow.getCell(6).numFmt = '0.00%';
    excelRow.getCell(8).numFmt = '0.00%';
    excelRow.getCell(9).numFmt = '#,##0';
    excelRow.getCell(10).numFmt = '#,##0.00';
    excelRow.getCell(11).numFmt = '#,##0.00';
    excelRow.getCell(12).numFmt = '#,##0.00';

    for (let c = 1; c <= NUM_COLS; c++) {
      const cell = excelRow.getCell(c);
      cell.border = allBorders;
      cell.alignment = { horizontal: c === 2 ? 'left' : 'center', vertical: 'middle' };
    }
    excelRow.getCell(10).fill = COMMISSION_FILL;
    excelRow.getCell(10).font = { bold: true };
    r++;
  }

  const totalRowIdx = r;
  ws.mergeCells(totalRowIdx, 1, totalRowIdx, 9);
  const totalLabelCell = ws.getCell(totalRowIdx, 1);
  totalLabelCell.value = 'Total';
  totalLabelCell.font = { bold: true };
  totalLabelCell.alignment = { horizontal: 'right', vertical: 'middle' };
  totalLabelCell.border = allBorders;
  for (let c = 2; c <= 9; c++) ws.getCell(totalRowIdx, c).border = allBorders;

  const totalCommissionCell = ws.getCell(totalRowIdx, 10);
  totalCommissionCell.value = Math.round(total * 100) / 100;
  totalCommissionCell.numFmt = '#,##0.00';
  totalCommissionCell.font = { bold: true };
  totalCommissionCell.fill = COMMISSION_FILL;
  totalCommissionCell.border = allBorders;
  totalCommissionCell.alignment = { horizontal: 'center', vertical: 'middle' };

  const totalByClientCell = ws.getCell(totalRowIdx, 11);
  totalByClientCell.value = Math.round(totalByClient * 100) / 100;
  totalByClientCell.numFmt = '#,##0.00';
  totalByClientCell.font = { bold: true };
  totalByClientCell.border = allBorders;
  totalByClientCell.alignment = { horizontal: 'center', vertical: 'middle' };

  const totalNxtCell = ws.getCell(totalRowIdx, 12);
  totalNxtCell.value = Math.round(totalNxt * 100) / 100;
  totalNxtCell.numFmt = '#,##0.00';
  totalNxtCell.font = { bold: true };
  totalNxtCell.border = allBorders;
  totalNxtCell.alignment = { horizontal: 'center', vertical: 'middle' };

  ws.views = [{ state: 'frozen', ySplit: 2 }];

  const defaultOut = path.join(__dirname, '..', '..', `PixlerPay_Commission_${START}_to_${END}.xlsx`);
  const outPath = outArg ? path.resolve(outArg) : defaultOut;
  await wb.xlsx.writeFile(outPath);
  console.log(`Written to ${outPath}`);
  console.log(`Total commission: Rs ${Math.round(total * 100) / 100}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
