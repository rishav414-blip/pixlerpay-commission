// One-off: Paynix onboarded clients (name + email), built from
// data/paynix-merchant-logins.json (merchant-portal login emails) and
// tallied against data/paynix-snapshot.json (live reseller-portal merchant
// list) so any merchant present on the reseller portal but missing a known
// login email is flagged rather than silently dropped.
const path = require('path');
const ExcelJS = require('exceljs');

const logins = require('../data/paynix-merchant-logins.json');
const resellerMerchants = require('../data/paynix-snapshot.json').merchants || [];

const loginById = new Map(logins.map((l) => [l.merchantId, l]));
const resellerById = new Map(resellerMerchants.map((m) => [m.merchantId, m]));

const rows = [];

// Merchants with a known login email (join in reseller status if present)
for (const l of logins) {
  const r = resellerById.get(l.merchantId);
  rows.push({
    name: l.merchantName,
    email: l.username,
    merchantId: l.merchantId,
    status: r ? r.status : 'Not in current reseller portal snapshot',
  });
}

// Reseller-portal merchants with NO known login email — flagged, not dropped
for (const m of resellerMerchants) {
  if (!loginById.has(m.merchantId)) {
    rows.push({
      name: m.merchantName,
      email: '(no login email on file)',
      merchantId: m.merchantId,
      status: m.status,
    });
  }
}

rows.sort((a, b) => a.name.localeCompare(b.name));

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Paynix Onboarded Clients');

ws.columns = [
  { header: 'S.No', key: 'sno', width: 6 },
  { header: 'Client Name', key: 'name', width: 45 },
  { header: 'Email ID', key: 'email', width: 35 },
  { header: 'Merchant ID', key: 'merchantId', width: 20 },
  { header: 'Reseller Portal Status', key: 'status', width: 28 },
];

const headerRow = ws.getRow(1);
headerRow.eachCell((cell) => {
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border = {
    top: { style: 'thin' }, left: { style: 'thin' },
    bottom: { style: 'thin' }, right: { style: 'thin' },
  };
});

rows.forEach((r, i) => {
  const row = ws.addRow({ sno: i + 1, name: r.name, email: r.email, merchantId: r.merchantId, status: r.status });
  const flagged = r.email === '(no login email on file)';
  row.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin' }, left: { style: 'thin' },
      bottom: { style: 'thin' }, right: { style: 'thin' },
    };
    if (flagged) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    }
  });
});

const outPath = process.argv[2] || path.join(__dirname, '..', '..', 'Paynix_Onboarded_Clients.xlsx');

wb.xlsx.writeFile(outPath).then(() => {
  const flaggedCount = rows.filter((r) => r.email === '(no login email on file)').length;
  console.log(`Wrote ${rows.length} Paynix merchants to ${outPath} (${flaggedCount} flagged: no login email on file)`);
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
