import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const PAYNIX_RESULTS_FILE = path.join('./website', 'paynix-results.json');
const PIXLERPAY_MERCHANT_RESULTS_FILE = path.join('./website', 'pixlerpay-merchant-results.json');
const PIXLERPAY_RESULTS_FILE = path.join('./website', 'commission-results.json');
const PIXLERPAY_PREVIOUS_SNAPSHOT_FILE = path.join('./data', 'pixlerpay-telegram-previous.json');

// Cap on how many wallet top-up entries are shown per merchant in a single
// alert message — per explicit request, only the 2 most recent, not every
// "new" entry (a merchant could have several new ones between 15-min checks).
const MAX_WALLET_ENTRIES_PER_MERCHANT = 2;

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

function loadRequestLine(r) {
  const ts = r.createdAt ? ` — ${r.createdAt}` : '';
  return `  • ${r.requestId || '-'} — ₹${r.amount.toLocaleString('en-IN')} — ${r.method || '-'} — ${r.status || '-'}${ts}`;
}

// Sorts newest-first (createdAt strings from Paynix are "DD/MM/YY, h:mm a"
// format, not directly sortable — but entries arrive from the scraper
// already newest-first per merchant, so just take the head) and caps to
// MAX_WALLET_ENTRIES_PER_MERCHANT.
function capWalletEntries(entries) {
  return entries.slice(0, MAX_WALLET_ENTRIES_PER_MERCHANT);
}

function buildPaynixMessage(d) {
  const lines = [];

  if (d.newFailedPayouts && d.newFailedPayouts.length > 0) {
    lines.push(`⚠ <b>${d.newFailedPayouts.length} new failed payout(s)</b>`);
    for (const f of d.newFailedPayouts.slice(0, 10)) {
      const amount = f.amount != null ? `₹${f.amount.toLocaleString('en-IN')}` : '-';
      lines.push(`  • ${f.transactionId || '-'} — ${amount} — ${f.reason || 'no reason captured'}`);
    }
    if (d.newFailedPayouts.length > 10) lines.push(`  …and ${d.newFailedPayouts.length - 10} more`);
  }

  if (d.walletChanges && d.walletChanges.length > 0) {
    if (lines.length) lines.push('');
    lines.push(`↕ <b>Wallet changes</b>`);
    for (const c of d.walletChanges) {
      const sign = c.delta > 0 ? '+' : '';
      lines.push(`  • ${c.merchantName}: ${sign}₹${c.delta.toLocaleString('en-IN')}`);
    }
  }

  const merchantById = new Map((d.merchants || []).map((m) => [m.merchantId, m.merchantName]));
  const newLoadRequests = d.newLoadRequests || {};
  const merchantsWithNewRequests = Object.entries(newLoadRequests).filter(([, reqs]) => reqs.length > 0);
  if (merchantsWithNewRequests.length > 0) {
    if (lines.length) lines.push('');
    lines.push(`💰 <b>New wallet top-up request(s)</b>`);
    for (const [merchantId, reqs] of merchantsWithNewRequests) {
      lines.push(`  <i>${merchantById.get(merchantId) || merchantId}</i>`);
      const shown = capWalletEntries(reqs);
      for (const r of shown) lines.push(loadRequestLine(r));
      if (reqs.length > shown.length) lines.push(`    …and ${reqs.length - shown.length} more`);
    }
  }

  return lines.join('\n');
}

function buildPixlerMerchantMessage(d) {
  const reqs = d.newLoadRequests || [];
  if (reqs.length === 0) return '';
  const lines = [`💰 <b>PixlerPay Merchant — new wallet top-up request(s)</b>`];
  const shown = capWalletEntries(reqs);
  for (const r of shown) lines.push(loadRequestLine(r));
  if (reqs.length > shown.length) lines.push(`  …and ${reqs.length - shown.length} more`);
  return lines.join('\n');
}

// PixlerPay (18-account) commission summary + failure/idle alerts.
// PixlerPay previously had NO Telegram alerts at all — this compares
// against a small locally-tracked snapshot (client count + total
// commission + generatedAt) rather than the full 5MB+ results file, since
// we only need enough to detect "what changed since last alert."
function buildPixlerpayMessage(d) {
  const lines = [];

  const previous = fs.existsSync(PIXLERPAY_PREVIOUS_SNAPSHOT_FILE)
    ? JSON.parse(fs.readFileSync(PIXLERPAY_PREVIOUS_SNAPSHOT_FILE, 'utf-8'))
    : null;

  const newCommission = previous ? Math.round((d.totalCommission - previous.totalCommission) * 100) / 100 : null;
  const newTxns = previous ? d.totalSuccessfulTxns - previous.totalSuccessfulTxns : null;

  if (previous && (newTxns > 0 || newCommission > 0)) {
    lines.push(`📊 <b>PixlerPay update</b>`);
    lines.push(`  • ${newTxns.toLocaleString('en-IN')} new successful txn(s) — +₹${newCommission.toLocaleString('en-IN')} commission`);
    lines.push(`  • Running total: ${d.totalSuccessfulTxns.toLocaleString('en-IN')} txns, ₹${d.totalCommission.toLocaleString('en-IN')} commission`);
  }

  // Failure/idle alert: any client with a rate card entry but zero
  // transactions in this run's data (mirrors the "new failed payouts"
  // style alert on the Paynix side — surfaces broken scrapes or truly
  // idle accounts, not routine no-activity).
  if (d.idleClients && d.idleClients.length > 0) {
    if (lines.length) lines.push('');
    lines.push(`⚠ <b>PixlerPay: zero activity</b>`);
    lines.push(`  ${d.idleClients.join(', ')}`);
  }
  if (d.skippedReports && d.skippedReports.length > 0) {
    if (lines.length) lines.push('');
    lines.push(`⚠ <b>PixlerPay: scrape/rate-match failure</b>`);
    lines.push(`  ${d.skippedReports.join(', ')}`);
  }

  const msg = lines.join('\n');

  fs.writeFileSync(PIXLERPAY_PREVIOUS_SNAPSHOT_FILE, JSON.stringify({
    totalCommission: d.totalCommission,
    totalSuccessfulTxns: d.totalSuccessfulTxns,
    generatedAt: d.generatedAt,
  }, null, 2));

  return msg;
}

async function run() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping Telegram alert (not configured yet).');
    return;
  }

  const messages = [];

  if (fs.existsSync(PAYNIX_RESULTS_FILE)) {
    const d = JSON.parse(fs.readFileSync(PAYNIX_RESULTS_FILE, 'utf-8'));
    const msg = buildPaynixMessage(d);
    if (msg) messages.push(msg);
  }

  if (fs.existsSync(PIXLERPAY_MERCHANT_RESULTS_FILE)) {
    const d = JSON.parse(fs.readFileSync(PIXLERPAY_MERCHANT_RESULTS_FILE, 'utf-8'));
    const msg = buildPixlerMerchantMessage(d);
    if (msg) messages.push(msg);
  }

  if (fs.existsSync(PIXLERPAY_RESULTS_FILE)) {
    const d = JSON.parse(fs.readFileSync(PIXLERPAY_RESULTS_FILE, 'utf-8'));
    const msg = buildPixlerpayMessage(d);
    if (msg) messages.push(msg);
  }

  if (messages.length === 0) {
    console.log('Nothing new to alert on.');
    return;
  }

  for (const msg of messages) {
    await sendTelegramMessage(msg);
  }
  console.log(`Telegram alert(s) sent: ${messages.length}.`);
}

run().catch((err) => {
  console.error('Telegram alert failed:', err.message);
  process.exit(1);
});
