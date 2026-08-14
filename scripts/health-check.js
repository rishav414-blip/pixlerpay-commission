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
  GOOGLE_DRIVE_PAYNIX_COMMISSION_FILE_ID,
  GOOGLE_DRIVE_PAYNIX_WALLETLOG_FILE_ID,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GITHUB_TOKEN,
} = process.env;

// Real cadence is ~60-90 min for refresh.yml (GitHub's `schedule` trigger
// is best-effort, see HANDOFF.md) — thresholds set well above its
// configured 30-min cadence to avoid false alarms on normal scheduling
// jitter, but tight enough to catch a genuinely stuck pipeline. Used for
// Drive-snapshot freshness (checkFreshnessAndData) and as the default for
// any workflow not given its own thresholds below.
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
// Per-workflow staleness thresholds, added 2026-08-12 — the shared
// WARN/CRITICAL_STALE_MS above (2h/4h) is tuned for refresh.yml's ~30-90
// min cadence and was silently useless for wallet-alert.yml, which runs
// every ~5 min via external cron: a real ~16-minute gap (3 consecutive
// dispatches cancelled while queued behind a slow-to-be-scheduled run —
// see the cancelled-run-streak check below for the actual root cause)
// produced zero alert, since it never got remotely close to 2 hours.
const WORKFLOWS = [
  { file: 'refresh.yml', warnMs: WARN_STALE_MS, criticalMs: CRITICAL_STALE_MS },
  { file: 'wallet-alert.yml', warnMs: 15 * 60 * 1000, criticalMs: 30 * 60 * 1000 },
];

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
  // something working exactly as intended.
  //
  // "PixlerPay Merchant" (PixlerPay's own account on Paynix,
  // GOOGLE_DRIVE_PIXLERPAY_MERCHANT_FILE_ID) removed the same way
  // 2026-08-13 — also intentionally held now, per explicit request after
  // this exact check correctly flagged it CRITICAL (119h stale) and the
  // response was "that's fine, stop refreshing it and stop checking it,"
  // not "fix the staleness." Same reasoning as above: checking it would
  // just produce a permanent alert for an intentional state.
  const sources = [
    { label: 'Paynix reseller', fileId: GOOGLE_DRIVE_PAYNIX_FILE_ID, tsField: 'scrapedAt' },
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

// A run that shows "cancelled" with zero jobs ever having started is
// GitHub's own concurrency-group behavior (cancel-in-progress: false
// allows only one *queued* run behind the currently-running one; a newer
// dispatch arriving before the queued one gets a runner cancels that
// older queued run, not whatever's actually executing). Confirmed live
// 2026-08-12: 3 consecutive wallet-alert.yml dispatches (16:01, 16:05,
// 16:10) got cancelled this way despite the previous run having already
// finished cleanly at 15:59 — runner-assignment delay (GitHub-side queue
// congestion, not a bug in this repo) let dispatches stack up faster than
// they could actually start. Distinguishing this from a real code failure
// matters: a cancelled-run streak means "the workflow never got to run
// its own logic at all", not "its logic broke" — the message should say
// so, since the fix (wait it out / manually dispatch once) is different
// from debugging a script.
const CANCELLED_STREAK_THRESHOLD = 3;

async function checkWorkflowHealth() {
  if (!GITHUB_TOKEN) {
    flag('WARNING', 'Workflow-run health check skipped — no GITHUB_TOKEN available.');
    return;
  }
  for (const { file: wf, warnMs, criticalMs } of WORKFLOWS) {
    try {
      // Same bug class fixed 2026-08-13/14 elsewhere (no default timeout
      // on a bare fetch()) — applied here too since this runs once per
      // workflow in a loop, same shape as the ones that actually hung.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      let res;
      try {
        res = await fetch(
          `https://api.github.com/repos/${WORKFLOWS_REPO}/actions/workflows/${wf}/runs?per_page=5`,
          { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: controller.signal }
        );
      } finally {
        clearTimeout(timeoutId);
      }
      if (!res.ok) {
        flag('WARNING', `Workflow ${wf}: could not query run history (HTTP ${res.status}).`);
        continue;
      }
      const json = await res.json();
      const runs = json.workflow_runs || [];

      // Most-recent-first streak of cancelled runs, checked before the
      // staleness check below so a queue-congestion pattern gets its own
      // clear diagnosis instead of just reading as generic staleness.
      let cancelledStreak = 0;
      for (const r of runs) {
        if (r.conclusion !== 'cancelled') break;
        cancelledStreak++;
      }
      if (cancelledStreak >= CANCELLED_STREAK_THRESHOLD) {
        flag('CRITICAL', `Workflow ${wf}: last ${cancelledStreak} run(s) cancelled before starting (queue congestion — dispatches arriving faster than GitHub is assigning runners, not a code failure). Next successful run will self-correct (diff-since-last-success + partial-read-guard merge already tolerate the gap) — if this persists past a few cycles, trigger one manual "Run workflow" to break the cancellation cycle.`);
        continue;
      }

      const lastSuccess = runs.find((r) => r.conclusion === 'success');
      if (!lastSuccess) {
        flag('CRITICAL', `Workflow ${wf}: no successful run in the last 5 attempts.`);
        continue;
      }
      const age = ageMs(lastSuccess.updated_at);
      if (age >= criticalMs) {
        flag('CRITICAL', `Workflow ${wf}: last success ${fmtAge(age)} ago.`);
      } else if (age >= warnMs) {
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
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
