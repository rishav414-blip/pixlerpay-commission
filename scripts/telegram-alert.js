import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const PAYNIX_RESULTS_FILE = path.join('./website', 'paynix-results.json');

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

function buildMessage(d) {
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

  return lines.join('\n');
}

async function run() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping Telegram alert (not configured yet).');
    return;
  }
  if (!fs.existsSync(PAYNIX_RESULTS_FILE)) {
    console.log(`${PAYNIX_RESULTS_FILE} not found — nothing to alert on.`);
    return;
  }

  const d = JSON.parse(fs.readFileSync(PAYNIX_RESULTS_FILE, 'utf-8'));
  const message = buildMessage(d);

  if (!message) {
    console.log('No new failed payouts or wallet changes — no alert sent.');
    return;
  }

  await sendTelegramMessage(message);
  console.log('Telegram alert sent.');
}

run().catch((err) => {
  console.error('Telegram alert failed:', err.message);
  process.exit(1);
});
