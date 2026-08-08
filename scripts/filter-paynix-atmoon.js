// Filters the three Paynix Drive files down to the 10 "Atmoon" merchants
// and strips AK-commission fields entirely, for a separate page
// (docs/paynix-atmoon.html) meant to be shared with someone who should
// only ever see this subset. This is a genuine server-side filter, not a
// client-side view toggle — the person receiving the link never has the
// full merchant roster reach their browser at all.
//
// Runs after the normal Paynix scrape/calculate steps in both
// refresh.yml and wallet-alert.yml. Each output is only written if its
// source file exists locally this run (wallet-alert.yml only ever
// produces the wallet-log source, refresh.yml produces the other two).

import fs from 'node:fs';
import path from 'node:path';

const ATMOON_MERCHANT_IDS = new Set([
  'MER_F2155A2A1F99', // SHESTYLE BULK TRADERS PRIVATE LIMITED
  'MER_0D622C7553A1', // RAAMIRO TRINTROY PRIVATE LIMITED
  'MER_E75F374D3B5A', // WILDBADGER TECHNOLOGY PRIVATE LIMITED
  'MER_CC95D8E2A947', // TECHMARKETIQ TECHNOLOGY PRIVATE LIMITED
  'MER_81FB09B83B4C', // KAHUA SYSTEMS PRIVATE LIMITED
  'MER_EB9A8C4D9025', // VIKZONE TECHNOLOGY PRIVATE LIMITED
  'MER_EB1BE5D25983', // VYSHIKAX TECHNOLOGY PRIVATE LIMITED
  'MER_810B49283330', // VELCYNTRA TECHNOLOGIES PRIVATE LIMITED
  'MER_19F368135CE0', // ZYPHERON TECHNOLOGY PRIVATE LIMITED
  'MER_1F18C5EDCA3B', // RASHEEYA TECHNOLOGY PRIVATE LIMITED
]);

const COMMISSION_SRC = path.join('./website', 'paynix-commission-results.json');
const RESELLER_SRC = path.join('./website', 'paynix-results.json');
const WALLETLOG_SRC = path.join('./website', 'paynix-wallet-log-results.json');

const COMMISSION_OUT = path.join('./website', 'paynix-atmoon-commission-results.json');
const RESELLER_OUT = path.join('./website', 'paynix-atmoon-results.json');
const WALLETLOG_OUT = path.join('./website', 'paynix-atmoon-wallet-log-results.json');

function stripAk(client) {
  // eslint-disable-next-line no-unused-vars
  const { akPct, totalAkCommission, ...rest } = client;
  return rest;
}

function filterCommission() {
  if (!fs.existsSync(COMMISSION_SRC)) return false;
  const d = JSON.parse(fs.readFileSync(COMMISSION_SRC, 'utf-8'));
  const clients = (d.clients || []).filter((c) => ATMOON_MERCHANT_IDS.has(c.merchantId)).map(stripAk);
  const transactions = (d.transactions || []).filter(([merchantId]) => ATMOON_MERCHANT_IDS.has(merchantId));
  let totalSuccessfulTxns = 0, totalCommission = 0, totalAnsCommission = 0;
  for (const c of clients) {
    totalSuccessfulTxns += c.successfulTxns;
    totalCommission += c.totalCommission;
    totalAnsCommission += c.totalAnsCommission;
  }
  const out = {
    generatedAt: d.generatedAt,
    totalSuccessfulTxns,
    totalCommission: Math.round(totalCommission * 100) / 100,
    totalAnsCommission: Math.round(totalAnsCommission * 100) / 100,
    clients,
    transactions,
  };
  fs.mkdirSync(path.dirname(COMMISSION_OUT), { recursive: true });
  fs.writeFileSync(COMMISSION_OUT, JSON.stringify(out, null, 2));
  console.log(`Atmoon commission results: ${clients.length} client(s), ${transactions.length} transaction(s) -> ${COMMISSION_OUT}`);
  return true;
}

function filterReseller() {
  if (!fs.existsSync(RESELLER_SRC)) return false;
  const d = JSON.parse(fs.readFileSync(RESELLER_SRC, 'utf-8'));
  const merchants = (d.merchants || []).filter((m) => ATMOON_MERCHANT_IDS.has(m.merchantId));
  const failedPayouts = (d.failedPayouts || []).filter((f) => ATMOON_MERCHANT_IDS.has(f.merchantId));
  const newFailedPayouts = (d.newFailedPayouts || []).filter((f) => ATMOON_MERCHANT_IDS.has(f.merchantId));
  const walletChanges = (d.walletChanges || []).filter((c) => ATMOON_MERCHANT_IDS.has(c.merchantId));
  const out = {
    scrapedAt: d.scrapedAt,
    summary: { ...d.summary, activeMerchants: merchants.filter((m) => m.status === 'Active').length },
    merchants,
    failedPayouts,
    newFailedPayouts,
    walletChanges,
  };
  fs.mkdirSync(path.dirname(RESELLER_OUT), { recursive: true });
  fs.writeFileSync(RESELLER_OUT, JSON.stringify(out, null, 2));
  console.log(`Atmoon reseller results: ${merchants.length} merchant(s), ${failedPayouts.length} failed payout(s) -> ${RESELLER_OUT}`);
  return true;
}

function filterWalletLog() {
  if (!fs.existsSync(WALLETLOG_SRC)) return false;
  const d = JSON.parse(fs.readFileSync(WALLETLOG_SRC, 'utf-8'));
  const walletLogs = {};
  const newLoadRequests = {};
  for (const [merchantId, entries] of Object.entries(d.walletLogs || {})) {
    if (!ATMOON_MERCHANT_IDS.has(merchantId)) continue;
    walletLogs[merchantId] = entries;
  }
  for (const [merchantId, entries] of Object.entries(d.newLoadRequests || {})) {
    if (!ATMOON_MERCHANT_IDS.has(merchantId)) continue;
    newLoadRequests[merchantId] = entries;
  }
  const out = { walletLogs, newLoadRequests, walletLogsGeneratedAt: d.walletLogsGeneratedAt };
  fs.mkdirSync(path.dirname(WALLETLOG_OUT), { recursive: true });
  fs.writeFileSync(WALLETLOG_OUT, JSON.stringify(out, null, 2));
  console.log(`Atmoon wallet-log results: ${Object.keys(walletLogs).length} merchant(s) -> ${WALLETLOG_OUT}`);
  return true;
}

function run() {
  const wroteCommission = filterCommission();
  const wroteReseller = filterReseller();
  const wroteWalletLog = filterWalletLog();
  if (!wroteCommission && !wroteReseller && !wroteWalletLog) {
    console.log('No Paynix source files found this run — nothing to filter for Atmoon page.');
  }
}

run();
