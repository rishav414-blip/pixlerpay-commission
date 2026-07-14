// Computes margin commission + AK commission per Paynix client, from the
// per-merchant payout reports download-paynix-merchant-reports.js exports.
//
// IMPORTANT — Paynix's flat-rate band is different from PixlerPay's:
// PixlerPay only flat-rates the 100-200 amount band; Paynix flat-rates
// EVERYTHING below Rs 1000 (confirmed by the client 2026-07-13, e.g.
// Curiobyte: 0.75% reseller / 0.90% onboarded above Rs1000 -> 0.15%
// margin, but Rs10/Rs11 flat -> Rs1 flat margin for ANY amount < Rs1000,
// not just 100-200). An earlier version of this file wrongly reused the
// PixlerPay 100-200 condition, which overcharged percentage-based
// commission on every 200-999 transaction. Fixed here — do not reuse the
// PixlerPay 100-200 band logic for Paynix again.
//
// AK commission has no flat-band override at all (the rate card labels
// it "Ak part (From % only)") — always amount x akPct regardless of amount.
//
// Clients with no merchantId mapping in the rate card, or no exported
// report file (the 4 known-missing merchant logins — see HANDOFF.md
// limitation #7), are marked hasData: false rather than silently
// reported as zero.

import fs from 'node:fs';
import path from 'node:path';

const RATES_FILE = path.join('./data', 'paynix-commission-rates.json');
const REPORTS_DIR = path.join('./data', 'paynix-merchant-reports');
const OUTPUT_JSON = path.join('./website', 'paynix-commission-results.json');

function isSuccessful(status) {
  return String(status || '').trim().toUpperCase() === 'SUCCESS';
}

// Paynix merchant export dates look like "9/7/2026, 12:37:47 pm" (D/M/YYYY).
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

function calcMarginCommission(amount, rate) {
  if (amount <= 1000 && rate.onboardedFlatBelow1000 != null && rate.resellerFlatBelow1000 != null) {
    return rate.onboardedFlatBelow1000 - rate.resellerFlatBelow1000;
  }
  return (amount * (rate.onboardedPct - rate.resellerPct)) / 100;
}

// Confirmed against Paynix's own wallet ledger (2026-07-13, cross-check
// of 10,036 matched transactions): below Rs1000, the flat differential
// IS the entire combined commission credited (margin+AK together) — AK
// is only split out separately when using the percentage tier (>= Rs1000).
// Adding AK on top of the flat rate for sub-1000 amounts double-counted
// it and caused ~2000 transaction-level mismatches vs Paynix's ledger.
function calcAkCommission(amount, rate) {
  if (amount <= 1000) return 0;
  if (rate.akPct == null) return 0;
  return (amount * rate.akPct) / 100;
}

function main() {
  const rates = JSON.parse(fs.readFileSync(RATES_FILE, 'utf-8'));

  const clients = [];
  const transactions = []; // [merchantId, isoDate, amount]
  let totalSuccessfulTxns = 0;
  let totalCommission = 0;
  let totalAkCommission = 0;

  for (const rate of rates) {
    if (!rate.merchantId) {
      clients.push({
        clientName: rate.clientName, merchantId: null, group: rate.group,
        resellerPct: rate.resellerPct, onboardedPct: rate.onboardedPct,
        resellerFlatBelow1000: rate.resellerFlatBelow1000, onboardedFlatBelow1000: rate.onboardedFlatBelow1000,
        akPct: rate.akPct, marginPct: Math.round((rate.onboardedPct - rate.resellerPct) * 100) / 100,
        hasData: false, successfulTxns: 0, totalAmount: 0, totalCommission: 0, totalAkCommission: 0,
      });
      continue;
    }

    const reportFile = path.join(REPORTS_DIR, `${rate.merchantId}.json`);
    if (!fs.existsSync(reportFile)) {
      clients.push({
        clientName: rate.clientName, merchantId: rate.merchantId, group: rate.group,
        resellerPct: rate.resellerPct, onboardedPct: rate.onboardedPct,
        resellerFlatBelow1000: rate.resellerFlatBelow1000, onboardedFlatBelow1000: rate.onboardedFlatBelow1000,
        akPct: rate.akPct, marginPct: Math.round((rate.onboardedPct - rate.resellerPct) * 100) / 100,
        hasData: false, successfulTxns: 0, totalAmount: 0, totalCommission: 0, totalAkCommission: 0,
      });
      continue;
    }

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
    let successfulTxns = 0, totalAmount = 0, clientCommission = 0, clientAkCommission = 0;

    for (const p of report.payouts) {
      if (!isSuccessful(p.status)) continue;
      const amount = Number(p.amount) || 0;
      const commission = calcMarginCommission(amount, rate);
      const akCommission = calcAkCommission(amount, rate);
      const isoDate = parseToISODate(p.createdAt);

      successfulTxns += 1;
      totalAmount += amount;
      clientCommission += commission;
      clientAkCommission += akCommission;
      totalSuccessfulTxns += 1;
      totalCommission += commission;
      totalAkCommission += akCommission;
      transactions.push([rate.merchantId, isoDate, amount]);
    }

    clients.push({
      clientName: rate.clientName, merchantId: rate.merchantId, group: rate.group,
      resellerPct: rate.resellerPct, onboardedPct: rate.onboardedPct,
      resellerFlatBelow1000: rate.resellerFlatBelow1000, onboardedFlatBelow1000: rate.onboardedFlatBelow1000,
      akPct: rate.akPct, marginPct: Math.round((rate.onboardedPct - rate.resellerPct) * 100) / 100,
      hasData: true, successfulTxns,
      totalAmount: Math.round(totalAmount * 100) / 100,
      totalCommission: Math.round(clientCommission * 100) / 100,
      totalAkCommission: Math.round(clientAkCommission * 100) / 100,
    });
  }

  const results = {
    generatedAt: new Date().toISOString(),
    totalSuccessfulTxns,
    totalCommission: Math.round(totalCommission * 100) / 100,
    totalAkCommission: Math.round(totalAkCommission * 100) / 100,
    clients: clients.sort((a, b) => b.totalCommission - a.totalCommission),
    transactions,
  };

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));
  console.log(`Paynix commission results written to ${OUTPUT_JSON}`);
  console.log(`Total successful txns: ${totalSuccessfulTxns}, Commission: Rs ${results.totalCommission}, AK Commission: Rs ${results.totalAkCommission}`);
  const noData = clients.filter((c) => !c.hasData);
  if (noData.length) {
    console.warn(`${noData.length} client(s) with no data available: ${noData.map((c) => c.clientName).join(', ')}`);
  }
}

main();
