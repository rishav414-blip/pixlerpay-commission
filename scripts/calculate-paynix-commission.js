// Computes margin commission + AK commission per Paynix client, from the
// per-merchant payout reports download-paynix-merchant-reports.js exports.
//
// IMPORTANT — Paynix's flat-rate band is different from PixlerPay's:
// PixlerPay only flat-rates the 100-200 amount band; Paynix flat-rates
// EVERYTHING below Rs 1000 (confirmed by the client 2026-07-13, e.g.
// Curiobyte: 0.75% reseller / 0.90% onboarded above Rs1000 -> 0.15%
// margin, but Rs10/Rs11 flat -> Rs1 flat margin for ANY amount <= Rs1000,
// not just 100-200). An earlier version of this file wrongly reused the
// PixlerPay 100-200 condition, which overcharged percentage-based
// commission on every 200-999 transaction. Fixed here — do not reuse the
// PixlerPay 100-200 band logic for Paynix again.
//
// AK commission has no flat-band override at all (the rate card labels
// it "Ak part (From % only)") — always amount x akPct, and ONLY above
// Rs1000 (below that, the flat differential already IS the combined
// margin+AK commission — confirmed against Paynix's own wallet ledger).
//
// Clients with no merchantId mapping in the rate card, or no exported
// report file (the 4 known-missing merchant logins — see HANDOFF.md
// limitation #7), are marked hasData: false rather than silently
// reported as zero.
//
// Incremental + 30-day retention (2026-07-14): download-paynix-merchant-
// reports.js now fetches only a recent window per merchant (not full
// lifetime history — see that script for why). This script merges that
// fresh window against the previously published Drive snapshot (deduped
// by payoutId, same pattern as calculate-commission.js), then prunes
// anything older than RETENTION_DAYS before recomputing aggregates.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fetchPreviousFromDrive } from './lib/drive-fetch.js';

const RATES_FILE = path.join('./data', 'paynix-commission-rates.json');
const REPORTS_DIR = path.join('./data', 'paynix-merchant-reports');
const OUTPUT_JSON = path.join('./website', 'paynix-commission-results.json');
const RETENTION_DAYS = 30;

const { GOOGLE_DRIVE_PAYNIX_COMMISSION_FILE_ID, GOOGLE_DRIVE_API_KEY } = process.env;

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

function calcAkCommission(amount, rate) {
  if (amount <= 1000) return 0;
  if (rate.akPct == null) return 0;
  return (amount * rate.akPct) / 100;
}

async function main() {
  const rates = JSON.parse(fs.readFileSync(RATES_FILE, 'utf-8'));
  const rateByMerchant = {};
  for (const r of rates) if (r.merchantId) rateByMerchant[r.merchantId] = r;

  // --- Phase 1: read this run's freshly fetched (recent-window) reports --
  // Keyed by payoutId so merging against history is a simple dedupe.
  const freshByPayoutId = new Map();
  for (const rate of rates) {
    if (!rate.merchantId) continue;
    const reportFile = path.join(REPORTS_DIR, `${rate.merchantId}.json`);
    if (!fs.existsSync(reportFile)) continue;
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
    for (const p of report.payouts) {
      if (!isSuccessful(p.status)) continue;
      if (!p.payoutId) continue; // can't safely dedupe without a stable ID
      const amount = Number(p.amount) || 0;
      const isoDate = parseToISODate(p.createdAt);
      freshByPayoutId.set(p.payoutId, [rate.merchantId, isoDate, amount, p.payoutId]);
    }
  }

  // --- Phase 2: merge against the previously published snapshot ----------
  const previous = await fetchPreviousFromDrive(GOOGLE_DRIVE_PAYNIX_COMMISSION_FILE_ID, GOOGLE_DRIVE_API_KEY);
  const mergedByPayoutId = new Map();
  if (previous?.transactions) {
    for (const t of previous.transactions) {
      const [merchantId, isoDate, amount, payoutId] = t;
      if (!payoutId) continue; // pre-migration 3-tuples — see calculate-commission.js for why these are dropped, not carried forward
      mergedByPayoutId.set(payoutId, [merchantId, isoDate, amount, payoutId]);
    }
  }
  for (const [payoutId, t] of freshByPayoutId) {
    mergedByPayoutId.set(payoutId, t); // fresh data wins on conflict
  }

  // --- Phase 3: prune anything older than the retention window -----------
  const cutoffISO = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const prunedTransactions = Array.from(mergedByPayoutId.values()).filter((t) => {
    const isoDate = t[1];
    return !isoDate || isoDate >= cutoffISO;
  });

  // --- Phase 4: recompute all aggregates from the merged + pruned log -----
  const perMerchant = new Map();
  let totalSuccessfulTxns = 0;
  let totalCommission = 0;
  let totalAkCommission = 0;
  for (const [merchantId, , amount] of prunedTransactions) {
    const rate = rateByMerchant[merchantId];
    if (!rate) continue;
    const commission = calcMarginCommission(amount, rate);
    const akCommission = calcAkCommission(amount, rate);

    totalSuccessfulTxns += 1;
    totalCommission += commission;
    totalAkCommission += akCommission;

    if (!perMerchant.has(merchantId)) {
      perMerchant.set(merchantId, { successfulTxns: 0, totalAmount: 0, totalCommission: 0, totalAkCommission: 0 });
    }
    const agg = perMerchant.get(merchantId);
    agg.successfulTxns += 1;
    agg.totalAmount += amount;
    agg.totalCommission += commission;
    agg.totalAkCommission += akCommission;
  }

  const clients = rates.map((rate) => {
    const base = {
      clientName: rate.clientName, merchantId: rate.merchantId, group: rate.group,
      resellerPct: rate.resellerPct, onboardedPct: rate.onboardedPct,
      resellerFlatBelow1000: rate.resellerFlatBelow1000, onboardedFlatBelow1000: rate.onboardedFlatBelow1000,
      akPct: rate.akPct, marginPct: Math.round((rate.onboardedPct - rate.resellerPct) * 100) / 100,
    };
    const agg = rate.merchantId ? perMerchant.get(rate.merchantId) : null;
    if (!agg) {
      return { ...base, hasData: false, successfulTxns: 0, totalAmount: 0, totalCommission: 0, totalAkCommission: 0 };
    }
    return {
      ...base, hasData: true, successfulTxns: agg.successfulTxns,
      totalAmount: Math.round(agg.totalAmount * 100) / 100,
      totalCommission: Math.round(agg.totalCommission * 100) / 100,
      totalAkCommission: Math.round(agg.totalAkCommission * 100) / 100,
    };
  });

  const results = {
    generatedAt: new Date().toISOString(),
    totalSuccessfulTxns,
    totalCommission: Math.round(totalCommission * 100) / 100,
    totalAkCommission: Math.round(totalAkCommission * 100) / 100,
    clients: clients.sort((a, b) => b.totalCommission - a.totalCommission),
    // [merchantId, isoDate, amount, payoutId]
    transactions: prunedTransactions,
  };

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));
  console.log(`Paynix commission results written to ${OUTPUT_JSON}`);
  console.log(`Merged transaction log: ${mergedByPayoutId.size} total, ${prunedTransactions.length} within ${RETENTION_DAYS}-day retention window (cutoff ${cutoffISO}).`);
  console.log(`Total successful txns: ${totalSuccessfulTxns}, Commission: Rs ${results.totalCommission}, AK Commission: Rs ${results.totalAkCommission}`);
  const noData = clients.filter((c) => !c.hasData);
  if (noData.length) {
    console.warn(`${noData.length} client(s) with no data available: ${noData.map((c) => c.clientName).join(', ')}`);
  }
}

main();
