import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parseWalletTimestamp } from './lib/wallet-timestamp.js';
import { getSuspendedMerchantIds } from './lib/suspended-merchants.js';

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ALERT_SECTIONS, TELEGRAM_ATMOON_CHAT_ID, TELEGRAM_BABA_CHAT_ID, TELEGRAM_RAVINO_VIJAJ_CHAT_ID, TELEGRAM_DATSHA_CHAT_ID, GOOGLE_DRIVE_PAYNIX_FILE_ID, GOOGLE_DRIVE_API_KEY } = process.env;

// Per-merchant wallet-top-up-only routing to dedicated Telegram groups,
// each instead of (not in addition to) the default chat. Failed-payout
// alerts are unaffected — this only ever splits the topups section.
// Generalized 2026-08-11 (was: a single hardcoded ATMOON_MERCHANT_IDS set
// + isAtmoon boolean) into a list so adding the next one-off group is just
// one more entry here, not a repeat of this same refactor.
const TOPUP_ROUTES = [
  {
    label: 'Atmoon',
    chatId: TELEGRAM_ATMOON_CHAT_ID,
    // Added 2026-08-07 per explicit request (that group should only ever
    // show these merchants, not the full Paynix roster).
    merchantIds: new Set([
      'MER_F2155A2A1F99', // SHESTYLE BULK TRADERS PRIVATE LIMITED
      'MER_0D622C7553A1', // RAAMIRO TRINTROY PRIVATE LIMITED
      'MER_E75F374D3B5A', // WILDBADGER TECHNOLOGY PRIVATE LIMITED
      'MER_CC95D8E2A947', // TECHMARKETIQ TECHNOLOGY PRIVATE LIMITED
      'MER_81FB09B83B4C', // KAHUA SYSTEMS PRIVATE LIMITED
      'MER_EB9A8C4D9025', // VIKZONE TECHNOLOGY PRIVATE LIMITED
      'MER_EB1BE5D25983', // VYSHIKAX TECHNOLOGY PRIVATE LIMITED
      'MER_810B49283330', // VELCYNTRA TECHNOLOGIES PRIVATE LIMITED
      'MER_19F368135CE0', // ZYPHERON TECHNOLOGY PRIVATE LIMITED
      'MER_1F18C5EDCA3B', // RASHEEYA TECHNOLOGY PRIVATE LIMITED — added 2026-08-11
      'MER_BE152E9A611E', // PARAKEET ENGINEERING PVT LTD — added 2026-08-11, Ansh Part client
      'MER_DBC71D6C79ED', // SURAJ WELLNESS PRIVATE LIMITED — added 2026-08-11, Ansh Part client
    ]),
  },
  {
    label: 'Payout: Baba Enterprises',
    chatId: TELEGRAM_BABA_CHAT_ID,
    // Added 2026-08-11 per explicit request — its own dedicated group, not
    // Atmoon (an earlier attempt routed it there in error, reverted).
    merchantIds: new Set([
      'MER_AACC5365BC9F', // BABA ENTERPRISES
    ]),
  },
  {
    label: 'Paynix: Ravino and Vijaj',
    chatId: TELEGRAM_RAVINO_VIJAJ_CHAT_ID,
    // Added 2026-08-13 per explicit request — one shared group for both
    // merchants (portal login names GuriFashion/TheHyperMarshal, but the
    // reseller-portal legal names — and this group's own name — are
    // RAVINO/VIJAJ TRADERS PRIVATE LIMITED).
    merchantIds: new Set([
      'MER_B3DE4FC343D8', // RAVINO TRADERS PRIVATE LIMITED (TheHyperMarshal)
      'MER_59AE1E1BE1A6', // VIJAJ TRADERS PRIVATE LIMITED (GuriFashion)
    ]),
  },
  {
    label: 'Paynix: DATSHA',
    chatId: TELEGRAM_DATSHA_CHAT_ID,
    // Added 2026-08-13 per explicit request — its own dedicated group.
    merchantIds: new Set([
      'MER_C4E3E8911BE5', // DATSHA SOLUTION PVT LTD
    ]),
  },
];
const ALL_ROUTED_MERCHANT_IDS = new Set(TOPUP_ROUTES.flatMap((r) => [...r.merchantIds]));
const PAYNIX_RESULTS_FILE = path.join('./website', 'paynix-results.json');
// Own dedicated file (see download-paynix-merchant-wallets.js) — split
// out 2026-08-07 so wallet-alert.yml and refresh.yml never share a Drive
// file to race on.
const PAYNIX_WALLETLOG_RESULTS_FILE = path.join('./website', 'paynix-wallet-log-results.json');
const PIXLERPAY_MERCHANT_RESULTS_FILE = path.join('./website', 'pixlerpay-merchant-results.json');
// Written by lib/paynix-merchant-login.js's getAuthenticatedContext() on a
// login failure (see there for the backoff mechanism). Checked
// unconditionally below, regardless of TELEGRAM_ALERT_SECTIONS — both
// refresh.yml and wallet-alert.yml run this script in the same job right
// after the scrape that would have written these files, so they're always
// on local disk to read directly (no Drive round-trip needed).
const SESSIONS_DIR = path.join('./data', 'paynix-sessions');

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

async function sendTelegramMessage(text, chatId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
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

// Sorts newest-first by actual timestamp, then caps to MAX_WALLET_ENTRIES_PER_MERCHANT.
function capWalletEntries(entries) {
  return [...entries]
    .sort((a, b) => parseWalletTimestamp(b.createdAt) - parseWalletTimestamp(a.createdAt))
    .slice(0, MAX_WALLET_ENTRIES_PER_MERCHANT);
}

// Only low-balance failures are alert-worthy, per explicit request
// 2026-08-11 — other failure reasons (gateway rate-limiting, etc.) are
// still captured in failedPayouts/newFailedPayouts for the dashboard, just
// not pushed to Telegram. Observed reason text: "Gateway hdfc (200): Low
// balance to make this request." A bare "FAILED" (regex-miss fallback in
// download-paynix.js's scrape) has no confirmed cause, so it's excluded
// too rather than assumed to be a balance issue.
const LOW_BALANCE_REASON_RE = /low balance/i;

function buildFailedPayoutMessage(d) {
  const lowBalanceFailures = (d.newFailedPayouts || []).filter((f) => f.reason && LOW_BALANCE_REASON_RE.test(f.reason));
  if (lowBalanceFailures.length === 0) return '';
  const lines = [];
  // Sort newest-first (same DD/MM/YY timestamp format as wallet-log
  // entries — plain scrape order isn't reliably newest-first) and cap
  // at 10, so a burst of failures doesn't produce an unreadable wall
  // of text in one Telegram message.
  const sorted = [...lowBalanceFailures].sort((a, b) => parseWalletTimestamp(b.createdAt) - parseWalletTimestamp(a.createdAt));
  const shown = sorted.slice(0, 10);
  lines.push(`⚠ <b>${lowBalanceFailures.length} new failed payout(s) — low balance</b>`);
  for (const f of shown) {
    const amount = f.amount != null ? `₹${f.amount.toLocaleString('en-IN')}` : '-';
    const merchant = f.merchantName ? f.merchantName.split(' ')[0] : '-';
    const ts = f.createdAt ? ` — ${f.createdAt}` : '';
    lines.push(`  • ${f.transactionId || '-'} — ${merchant} — ${amount} — ${f.reason || 'no reason captured'}${ts}`);
  }
  if (sorted.length > shown.length) lines.push(`  …and ${sorted.length - shown.length} more`);
  return lines.join('\n');
}

// matchMerchantId: (merchantId) => boolean — which merchants this message
// should include. Callers pass a route's own Set membership check, or (for
// the default chat) "not claimed by any dedicated route".
function buildTopupMessage(d, matchMerchantId) {
  const newLoadRequests = d.newLoadRequests || {};
  // Cap per merchant first (so one very active merchant can't crowd out
  // everyone else), then flatten across all merchants and sort the whole
  // list newest-first by actual timestamp — was grouped by merchant with
  // only within-group ordering, so the message read oldest-merchant-first
  // rather than most-recent-event-first overall. merchantName is already
  // embedded per entry (download-paynix-merchant-wallets.js), no
  // cross-file merchant lookup needed.
  const flattened = [];
  for (const [merchantId, reqs] of Object.entries(newLoadRequests)) {
    if (!reqs.length) continue;
    if (!matchMerchantId(merchantId)) continue;
    for (const r of capWalletEntries(reqs)) flattened.push(r);
  }
  if (flattened.length === 0) return '';
  flattened.sort((a, b) => parseWalletTimestamp(b.createdAt) - parseWalletTimestamp(a.createdAt));
  const lines = [`💰 <b>New / status-changed wallet top-up request(s)</b>`];
  for (const r of flattened) lines.push(loadRequestLine(r));
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

// Sent as its own message, separate from the messages[] batch below, so a
// failure to mark a failure-state file `alerted` can't get tangled up with
// (or silently dropped by) the rest of the run. Only marks `alerted: true`
// after the send actually succeeds — if Telegram itself is down, the next
// run's retry will resend rather than the alert being lost.
async function sendLoginFailureAlertsIfAny() {
  if (!fs.existsSync(SESSIONS_DIR)) return;

  // A merchant that's since become suspended can leave a stale
  // .failure.json sitting in the CI session cache (actions/cache, restored
  // across runs) from before it was suspended — the scripts that actually
  // attempt logins already skip suspended merchants entirely (see
  // lib/suspended-merchants.js), so no *new* failure file is ever written
  // for them, but an old un-alerted one can linger and get re-surfaced by
  // a later cache restore. Confirmed 2026-08-13: alerts fired for
  // ANTARIKSHA/SUVIKA/BITNEXY days after they'd been suspended and their
  // login attempts stopped entirely. Delete these on sight rather than
  // just skip-and-leave-them — otherwise the same stale file can resurface
  // again on a future cache restore.
  const suspendedIds = await getSuspendedMerchantIds(GOOGLE_DRIVE_PAYNIX_FILE_ID, GOOGLE_DRIVE_API_KEY);

  const toAlert = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.failure.json')) continue;
    const full = path.join(SESSIONS_DIR, f);
    const merchantId = f.replace(/\.failure\.json$/, '');
    if (suspendedIds.has(merchantId)) {
      fs.unlinkSync(full);
      continue;
    }
    try {
      const state = JSON.parse(fs.readFileSync(full, 'utf-8'));
      if (!state.alerted) toAlert.push({ file: full, state });
    } catch {
      // Corrupt/unreadable failure-state file — skip it rather than crash
      // the whole telegram-alert run over it.
    }
  }
  if (toAlert.length === 0) return;

  const lines = [`🚨 <b>CRITICAL: Paynix login failure(s)</b>`];
  for (const { state } of toAlert) {
    const err = (state.lastErrorMessage || 'unknown error').slice(0, 150);
    lines.push(`  • <b>${state.merchantLabel || 'unknown account'}</b> — ${state.consecutiveFailures}x failed — ${err}`);
  }
  lines.push('\nAutomation is backing off ~20 min per account before retrying — no action needed unless this persists across several cycles.');

  await sendTelegramMessage(lines.join('\n'), TELEGRAM_CHAT_ID);
  for (const { file, state } of toAlert) {
    fs.writeFileSync(file, JSON.stringify({ ...state, alerted: true }, null, 2));
  }
  console.log(`Sent critical login-failure alert for ${toAlert.length} account(s).`);
}

async function run() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping Telegram alert (not configured yet).');
    return;
  }

  await sendLoginFailureAlertsIfAny();

  const messages = []; // { text, chatId }

  if (ENABLED_SECTIONS.has('failed') && fs.existsSync(PAYNIX_RESULTS_FILE)) {
    const d = JSON.parse(fs.readFileSync(PAYNIX_RESULTS_FILE, 'utf-8'));
    const msg = buildFailedPayoutMessage(d);
    if (msg) messages.push({ text: msg, chatId: TELEGRAM_CHAT_ID });
  }

  if (ENABLED_SECTIONS.has('topups') && fs.existsSync(PAYNIX_WALLETLOG_RESULTS_FILE)) {
    const d = JSON.parse(fs.readFileSync(PAYNIX_WALLETLOG_RESULTS_FILE, 'utf-8'));
    const defaultMsg = buildTopupMessage(d, (id) => !ALL_ROUTED_MERCHANT_IDS.has(id));
    if (defaultMsg) messages.push({ text: defaultMsg, chatId: TELEGRAM_CHAT_ID });

    for (const route of TOPUP_ROUTES) {
      if (!route.chatId) {
        console.log(`Chat ID for "${route.label}" not set — its top-up alerts are being skipped, not sent to the default chat.`);
        continue;
      }
      const msg = buildTopupMessage(d, (id) => route.merchantIds.has(id));
      if (msg) messages.push({ text: msg, chatId: route.chatId });
    }
  }

  if (fs.existsSync(PIXLERPAY_MERCHANT_RESULTS_FILE)) {
    const d = JSON.parse(fs.readFileSync(PIXLERPAY_MERCHANT_RESULTS_FILE, 'utf-8'));
    const msg = buildPixlerMerchantMessage(d);
    if (msg) messages.push({ text: msg, chatId: TELEGRAM_CHAT_ID });
  }

  // 18-account PixlerPay commission-summary alerts intentionally removed
  // 2026-08-06 per explicit request — only Paynix (top-ups/failures) and
  // the PixlerPay-own-merchant-account top-up alerts remain.

  if (messages.length === 0) {
    console.log('Nothing new to alert on.');
    return;
  }

  for (const { text, chatId } of messages) {
    await sendTelegramMessage(text, chatId);
  }
  console.log(`Telegram alert(s) sent: ${messages.length}.`);
}

run().catch((err) => {
  console.error('Telegram alert failed:', err.message);
  process.exit(1);
});
