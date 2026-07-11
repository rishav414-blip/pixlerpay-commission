import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const PAYNIX_RESULTS_FILE = path.join('./website', 'paynix-results.json');
const PIXLERPAY_MERCHANT_RESULTS_FILE = path.join('./website', 'pixlerpay-merchant-results.json');

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
  return `  • ${r.requestId || '-'} — ₹${r.amount.toLocaleString('en-IN')} — ${r.method || '-'} — ${r.status || '-'}`;
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
      for (const r of reqs) lines.push(loadRequestLine(r));
    }
  }

  return lines.join('\n');
}

function buildPixlerMerchantMessage(d) {
  const reqs = d.newLoadRequests || [];
  if (reqs.length === 0) return '';
  const lines = [`💰 <b>PixlerPay Merchant — new wallet top-up request(s)</b>`];
  for (const r of reqs) lines.push(loadRequestLine(r));
  return lines.join('\n');
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
