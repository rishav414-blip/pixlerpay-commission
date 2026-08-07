import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ALERT_SECTIONS } = process.env;
const PAYNIX_RESULTS_FILE = path.join('./website', 'paynix-results.json');
const PIXLERPAY_MERCHANT_RESULTS_FILE = path.join('./website', 'pixlerpay-merchant-results.json');

// Which Paynix sections this invocation should alert on. wallet-alert.yml
// (every 10 min) sets this to "topups" only; refresh.yml (every 30 min)
// sets it to "failed" only — added 2026-08-07 so top-up and failed-payout
// alerts run on their own independent cadences instead of both firing on
// whichever schedule happens to call this script. Unset (e.g. manual/local
// runs) means both sections are included, same as the old behavior.
const ENABLED_SECTIONS = TELEGRAM_ALERT_SECTIONS
  ? new Set(TELEGRAM_ALERT_SECTIONS.split(',').map((s) => s.trim()))
  : new Set(['topups', 'failed']);

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
  const status = r.previousStatus ? `${r.previousStatus} → ${r.status || '-'}` : (r.status || '-');
  const merchant = r.merchantName ? `<i>${r.merchantName}</i> — ` : '';
  return `  • ${merchant}${r.requestId || '-'} — ₹${r.amount.toLocaleString('en-IN')} — ${r.method || '-'} — ${status}${ts}`;
}

// Paynix wallet-log timestamps look like "13/07/26, 8:42 pm"
// (DD/MM/YY, h:mm am/pm). A plain string sort breaks across month
// boundaries (e.g. "02/07/26" < "30/06/26" alphabetically, even though
// June 30 is earlier than July 2) — this bit the webpage's consolidated
// wallet-log table (fixed 2026-07-14 in docs/index.html) and would have
// silently shown the wrong "2 most recent" entries here too if this had
// just trusted scrape order. Mirrors parseWalletTimestamp in
// docs/index.html — keep both in sync.
function parseWalletTimestamp(s) {
  const m = s && String(s).match(/^(\d{2})\/(\d{2})\/(\d{2}),\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return 0;
  let [, dd, mo, yy, hh, mm, ap] = m;
  hh = parseInt(hh, 10);
  if (/pm/i.test(ap) && hh !== 12) hh += 12;
  if (/am/i.test(ap) && hh === 12) hh = 0;
  return new Date(2000 + parseInt(yy, 10), parseInt(mo, 10) - 1, parseInt(dd, 10), hh, parseInt(mm, 10)).getTime();
}

// Sorts newest-first by actual timestamp, then caps to MAX_WALLET_ENTRIES_PER_MERCHANT.
function capWalletEntries(entries) {
  return [...entries]
    .sort((a, b) => parseWalletTimestamp(b.createdAt) - parseWalletTimestamp(a.createdAt))
    .slice(0, MAX_WALLET_ENTRIES_PER_MERCHANT);
}

function buildPaynixMessage(d) {
  const lines = [];

  if (ENABLED_SECTIONS.has('failed') && d.newFailedPayouts && d.newFailedPayouts.length > 0) {
    // Sort newest-first (same DD/MM/YY timestamp format as wallet-log
    // entries — plain scrape order isn't reliably newest-first) and cap
    // at 10, so a burst of failures doesn't produce an unreadable wall
    // of text in one Telegram message.
    const sorted = [...d.newFailedPayouts].sort((a, b) => parseWalletTimestamp(b.createdAt) - parseWalletTimestamp(a.createdAt));
    const shown = sorted.slice(0, 10);
    lines.push(`⚠ <b>${d.newFailedPayouts.length} new failed payout(s)</b>`);
    for (const f of shown) {
      const amount = f.amount != null ? `₹${f.amount.toLocaleString('en-IN')}` : '-';
      const merchant = f.merchantName ? f.merchantName.split(' ')[0] : '-';
      const ts = f.createdAt ? ` — ${f.createdAt}` : '';
      lines.push(`  • ${f.transactionId || '-'} — ${merchant} — ${amount} — ${f.reason || 'no reason captured'}${ts}`);
    }
    if (sorted.length > shown.length) lines.push(`  …and ${sorted.length - shown.length} more`);
  }

  if (ENABLED_SECTIONS.has('topups')) {
    const merchantById = new Map((d.merchants || []).map((m) => [m.merchantId, m.merchantName]));
    const newLoadRequests = d.newLoadRequests || {};
    // Cap per merchant first (so one very active merchant can't crowd out
    // everyone else), then flatten across all merchants and sort the
    // whole list newest-first by actual timestamp — was grouped by
    // merchant with only within-group ordering, so the message read
    // oldest-merchant-first rather than most-recent-event-first overall.
    const flattened = [];
    for (const [merchantId, reqs] of Object.entries(newLoadRequests)) {
      if (!reqs.length) continue;
      const merchantName = merchantById.get(merchantId) || merchantId;
      for (const r of capWalletEntries(reqs)) flattened.push({ ...r, merchantName });
    }
    if (flattened.length > 0) {
      flattened.sort((a, b) => parseWalletTimestamp(b.createdAt) - parseWalletTimestamp(a.createdAt));
      if (lines.length) lines.push('');
      lines.push(`💰 <b>New / status-changed wallet top-up request(s)</b>`);
      for (const r of flattened) lines.push(loadRequestLine(r));
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

  // 18-account PixlerPay commission-summary alerts intentionally removed
  // 2026-08-06 per explicit request — only Paynix (top-ups/failures) and
  // the PixlerPay-own-merchant-account top-up alerts remain.

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
