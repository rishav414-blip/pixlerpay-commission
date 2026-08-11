// Cross-cutting monitor for the whole pipeline — runs independently of
// refresh.yml/wallet-alert.yml (own schedule, own workflow) and checks
// every "department" for silent staleness/breakage that the operational
// alerts in telegram-alert.js don't cover (that script only reports NEW
// events like failed payouts/wallet changes — it says nothing if a whole
// department stops updating entirely, which is exactly the failure mode
// that bit this project multiple times per HANDOFF.md: stale local files
// clobbering fresher Drive data, a GitHub secret going stale after a
// local credential file changed, a rate card drifting from the live
// Google Sheet unnoticed, a CI step crashing silently under
// continue-on-error).
//
// Reads published Drive snapshots (same read-only API-key pattern as
// lib/drive-fetch.js) rather than local files, so this reports on the
// same data the live dashboard is actually showing — not just whatever
// happens to be on whatever machine runs this script.
//
// Sends ONE consolidated Telegram message only when something is actually
// wrong (silent otherwise, like telegram-alert.js) — a separate message
// prefix ("🔔 Health Check") keeps this distinguishable from the
// operational alerts.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import { fetchPreviousFromDrive } from './lib/drive-fetch.js';

const {
  GOOGLE_DRIVE_API_KEY,
  GOOGLE_DRIVE_PAYNIX_FILE_ID,
  GOOGLE_DRIVE_PIXLERPAY_MERCHANT_FILE_ID,
  GOOGLE_DRIVE_PAYNIX_COMMISSION_FILE_ID,
  GOOGLE_DRIVE_PAYNIX_WALLETLOG_FILE_ID,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GITHUB_TOKEN,
} = process.env;

// Real cadence is ~60-90 min (GitHub's `schedule` trigger is best-effort,
// see HANDOFF.md) — thresholds set well above the configured 15/30-min
// cadence to avoid false alarms on normal scheduling jitter, but tight
// enough to catch a genuinely stuck pipeline.
const WARN_STALE_MS = 2 * 60 * 60 * 1000; // 2h
const CRITICAL_STALE_MS = 4 * 60 * 60 * 1000; // 4h

const RATE_CARD_SHEET_ID = '124ZZg6E98XyQ882t5BeNSF4ng3KWceQJmCYX0H0kIW8';
// Clients that are visible in the live sheet but deliberately kept
// `hidden: true` locally — a local decision independent of the sheet's
// own row-hide state, confirmed with the user 2026-08-08 (they were
// un-hidden in the sheet but the user wants them to stay excluded from
// commission calc/dashboard regardless). Without this allowlist, the
// rate-card drift check below would flag them forever.
const INTENTIONALLY_HIDDEN_DESPITE_SHEET = new Set([
  'GLOBAL BOOKS TRADING PVT LTD',
  'SUVIKA VAITNIK PAY PRIVATE LIMITED',
  'PPAY SOLUTION PRIVATE LIMITED',
  'ANTARIKSHA DIGITECH PRIVATE LIMITED',
]);
const RATE_CARD_LOCAL = path.join('./data', 'paynix-commission-rates.json');
const CREDENTIAL_SYNC_STATE_FILE = path.join('./data', 'credential-sync-state.json');
const CREDENTIAL_FILES = [
  { name: 'ACCOUNTS_JSON', path: './data/accounts.json' },
  { name: 'PAYNIX_MERCHANT_LOGINS', path: './data/paynix-merchant-logins.json' },
];
const WORKFLOWS_REPO = 'rishav414-blip/pixlerpay-commission';
const WORKFLOWS = ['refresh.yml', 'wallet-alert.yml'];

const issues = []; // { severity: 'CRITICAL'|'WARNING', text }
function flag(severity, text) {
  issues.push({ severity, text });
}

function ageMs(iso) {
  if (!iso) return Infinity;
  return Date.now() - new Date(iso).getTime();
}

function fmtAge(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${(mins / 60).toFixed(1)}h`;
}

async function checkFreshnessAndData() {
  // "PixlerPay commission" (the 18-account direct PixlerPay business,
  // GOOGLE_DRIVE_RESULTS_FILE_ID) intentionally removed from freshness
  // checking 2026-08-11 — refresh.yml no longer refreshes it per explicit
  // request (this pipeline now concentrates on the Paynix system only),
  // so it's *supposed* to stay frozen/stale from here on. Checking it
  // would just have produced a permanent, unfixable CRITICAL alert for
  // something working exactly as intended. "PixlerPay Merchant" below is
  // unrelated — that's PixlerPay's own account on Paynix, still actively
  // refreshed, part of the Paynix system being kept.
  const sources = [
    { label: 'Paynix reseller', fileId: GOOGLE_DRIVE_PAYNIX_FILE_ID, tsField: 'scrapedAt' },
    { label: 'PixlerPay Merchant', fileId: GOOGLE_DRIVE_PIXLERPAY_MERCHANT_FILE_ID, tsField: 'scrapedAt' },
    { label: 'Paynix commission', fileId: GOOGLE_DRIVE_PAYNIX_COMMISSION_FILE_ID, tsField: 'generatedAt' },
    { label: 'Paynix wallet log', fileId: GOOGLE_DRIVE_PAYNIX_WALLETLOG_FILE_ID, tsField: 'walletLogsGeneratedAt' },
  ];

  for (const src of sources) {
    if (!src.fileId) {
      flag('WARNING', `${src.label}: no Drive file ID configured — can't check freshness.`);
      continue;
    }
    const data = await fetchPreviousFromDrive(src.fileId, GOOGLE_DRIVE_API_KEY);
    if (!data) {
      flag('CRITICAL', `${src.label}: could not fetch published snapshot from Drive at all.`);
      continue;
    }
    const age = ageMs(data[src.tsField]);
    if (age >= CRITICAL_STALE_MS) {
      flag('CRITICAL', `${src.label}: last updated ${fmtAge(age)} ago (expected ~30-90min cadence).`);
    } else if (age >= WARN_STALE_MS) {
      flag('WARNING', `${src.label}: last updated ${fmtAge(age)} ago.`);
    }

    // Per-department data-completeness signals already computed by the
    // calculation scripts — surfaced here rather than re-derived.
    if (src.label === 'Paynix commission') {
      const noData = (data.clients || []).filter((c) => !c.hasData);
      if (noData.length) {
        flag('WARNING', `Paynix commission: ${noData.length} client(s) with no data: ${noData.map((c) => c.clientName).join(', ')}.`);
      }
    }
  }
}

async function checkRateCardDrift() {
  try {
    if (!fs.existsSync('./data/gdrive-oauth-client.json') || !fs.existsSync('./data/gdrive-oauth-token.json')) {
      flag('WARNING', 'Rate-card drift check skipped — no Drive OAuth credentials on disk.');
      return;
    }
    const { installed } = JSON.parse(fs.readFileSync('./data/gdrive-oauth-client.json', 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync('./data/gdrive-oauth-token.json', 'utf-8'));
    const auth = new google.auth.OAuth2(installed.client_id, installed.client_secret);
    auth.setCredentials(tokens);
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.get({
      spreadsheetId: RATE_CARD_SHEET_ID,
      includeGridData: true,
      ranges: ['Sheet1!A1:B200'],
    });
    const rows = res.data.sheets[0].data[0].rowData || [];
    const rowMetadata = res.data.sheets[0].data[0].rowMetadata || [];
    const sheetNames = new Set();
    for (let i = 1; i < rows.length; i++) {
      const name = rows[i].values?.[1]?.formattedValue?.trim();
      const hidden = rowMetadata[i]?.hiddenByUser === true;
      if (name && !hidden) sheetNames.add(name.toUpperCase());
    }

    const localRates = JSON.parse(fs.readFileSync(RATE_CARD_LOCAL, 'utf-8'));
    const localNames = new Set(
      localRates.filter((r) => !r.hidden).map((r) => r.clientName.toUpperCase())
    );

    const missingLocally = [...sheetNames].filter(
      (n) => !localNames.has(n) && !INTENTIONALLY_HIDDEN_DESPITE_SHEET.has(n)
    );
    if (missingLocally.length) {
      flag('WARNING', `Rate card: ${missingLocally.length} client(s) in the live sheet not yet in data/paynix-commission-rates.json: ${missingLocally.join(', ')}.`);
    }
  } catch (err) {
    flag('WARNING', `Rate-card drift check failed: ${err.message}`);
  }
}

function checkCredentialSyncDrift() {
  // Only meaningful when run locally — the gitignored credential files
  // don't exist in a CI checkout except transiently (written from
  // secrets mid-run), so this check silently no-ops in CI.
  if (!fs.existsSync(CREDENTIAL_SYNC_STATE_FILE)) return;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(CREDENTIAL_SYNC_STATE_FILE, 'utf-8'));
  } catch {
    return;
  }
  for (const cred of CREDENTIAL_FILES) {
    if (!fs.existsSync(cred.path)) continue;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(cred.path)).digest('hex');
    const recorded = state[cred.name];
    if (!recorded) {
      flag('WARNING', `Credential ${cred.name}: no sync record — run scripts/sync-secret.js to mirror it to the GitHub secret.`);
    } else if (recorded.hash !== hash) {
      flag('WARNING', `Credential ${cred.name}: local file changed since it was last pushed to the GitHub secret (${recorded.syncedAt}) — CI may be using stale credentials.`);
    }
  }
}

async function checkWorkflowHealth() {
  if (!GITHUB_TOKEN) {
    flag('WARNING', 'Workflow-run health check skipped — no GITHUB_TOKEN available.');
    return;
  }
  for (const wf of WORKFLOWS) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${WORKFLOWS_REPO}/actions/workflows/${wf}/runs?per_page=5`,
        { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
      );
      if (!res.ok) {
        flag('WARNING', `Workflow ${wf}: could not query run history (HTTP ${res.status}).`);
        continue;
      }
      const json = await res.json();
      const runs = json.workflow_runs || [];
      const lastSuccess = runs.find((r) => r.conclusion === 'success');
      if (!lastSuccess) {
        flag('CRITICAL', `Workflow ${wf}: no successful run in the last 5 attempts.`);
        continue;
      }
      const age = ageMs(lastSuccess.updated_at);
      if (age >= CRITICAL_STALE_MS) {
        flag('CRITICAL', `Workflow ${wf}: last success ${fmtAge(age)} ago.`);
      } else if (age >= WARN_STALE_MS) {
        flag('WARNING', `Workflow ${wf}: last success ${fmtAge(age)} ago.`);
      }
    } catch (err) {
      flag('WARNING', `Workflow ${wf}: health check errored — ${err.message}`);
    }
  }
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — skipping alert, logging only.');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      console.error(`Telegram API error ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error(`Telegram send failed (network): ${err.message}`);
  }
}

// Each phase runs independently — a network hiccup in one check must not
// silently take down the whole health check (that would be exactly the
// kind of silent failure this script exists to catch elsewhere).
async function runPhase(name, fn) {
  try {
    await fn();
  } catch (err) {
    flag('WARNING', `${name} check crashed: ${err.message}`);
  }
}

async function run() {
  await runPhase('Freshness/data', checkFreshnessAndData);
  await runPhase('Rate-card drift', checkRateCardDrift);
  await runPhase('Credential-sync drift', checkCredentialSyncDrift);
  await runPhase('Workflow health', checkWorkflowHealth);

  if (issues.length === 0) {
    console.log('Health check: all departments OK.');
    return;
  }

  console.log(`Health check: ${issues.length} issue(s) found:`);
  for (const i of issues) console.log(`  [${i.severity}] ${i.text}`);

  const critical = issues.filter((i) => i.severity === 'CRITICAL');
  const warnings = issues.filter((i) => i.severity === 'WARNING');

  // Telegram only fires for CRITICAL issues — per explicit request
  // 2026-08-11, warnings are noisy/lower-signal (idle clients, rate-card
  // drift, a single stale-but-not-broken source) and were competing for
  // attention with genuinely urgent CRITICAL ones. Warnings still show up
  // in the CI run log above for anyone actually looking, just never in
  // Telegram. A run with only warnings and no criticals sends nothing.
  if (critical.length === 0) {
    console.log(`${warnings.length} warning(s) logged above, no Telegram alert sent (warnings-only).`);
    return;
  }

  const text = `🔔 <b>Health Check</b>\n\n<b>🛑 Critical (${critical.length})</b>\n` + critical.map((i) => `• ${i.text}`).join('\n');
  await sendTelegramMessage(text.trim());
}

run().catch((err) => {
  console.error('health-check.js crashed:', err);
  process.exit(1);
});
