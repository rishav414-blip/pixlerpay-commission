# Handoff — PixlerPay / Paynix Commission Dashboard

Last updated: 2026-07-11

## What this project is

Automates commission tracking across two merchant payment platforms and
publishes a live, tabbed web dashboard:

- **PixlerPay tab** — logs into 18 individual merchant accounts, downloads
  payout reports, calculates commission as margin (Onboarded % − Reseller %)
  per the Google Sheet rate card. One manual override for a client whose
  automation is broken (see Known Limitations).
- **Paynix tab** — logs into one reseller account (covers 13 merchants),
  scrapes commission (computed server-side by Paynix, no math needed),
  merchant wallet balances, failed payouts, and (for 9 of the 13 merchants
  — see Known Limitations) each merchant's own top-5 wallet "Load Requests"
  log (top-ups, both pending and approved).
- **PixlerPay Merchant tab** — logs into PixlerPay's *own* Paynix merchant
  account (`info@pixlerpay.com` on `merchant.paynix.co.in`, unrelated to
  the 13 reseller merchants above), exports its full payout history, and
  computes commission with a flat rule: 0.05% of amount for payouts over
  ₹1000, flat ₹1 at/below ₹1000 — applied to SUCCESS payouts only. Also
  shows this account's own wallet balance + top-5 wallet "Load Requests" log.

All three feed a single live dashboard hosted on GitHub Pages, reading data
from Google Drive. **The whole pipeline now runs automatically** via
GitHub Actions (see below) — no manual `npm run all` needed day to day.

## Live URLs

- **Dashboard:** https://rishav414-blip.github.io/pixlerpay-commission/
- **GitHub repo:** https://github.com/rishav414-blip/pixlerpay-commission (public)
- **Actions (automation runs/logs):** https://github.com/rishav414-blip/pixlerpay-commission/actions
- **Drive folder:** https://drive.google.com/drive/folders/1Rwxh-PnwfQ-xwuGI_cc7QFyyJlycJFe5 ("PixlerPay Commission Data")
- **Telegram bot:** @payout_alert_autobot

## Local project path

`C:\Users\RISHAV\Documents\Claude\Projects\Personal calculation\pixlerpay-commission`

## Automation (GitHub Actions — free, runs on its own)

Two scheduled workflows, both using GitHub-hosted runners (free/unlimited
minutes since this repo is public):

- **`.github/workflows/refresh.yml`** — every 30 min (`*/30 * * * *`) +
  manual "Run workflow" button. Runs the full pipeline: all 18 PixlerPay
  accounts, Paynix reseller + 9 merchant wallet logs, PixlerPay's own
  merchant account (full payout export), uploads everything to Drive, then
  runs the Telegram alert step. Takes ~5-10 min.
- **`.github/workflows/wallet-alert.yml`** — every 15 min (`*/15 * * * *`)
  + manual dispatch. Fast path scoped to just the Paynix side (reseller
  scrape + 9 merchant wallet logs) so new wallet top-up requests get
  alerted on quickly without re-running the slow 18-account PixlerPay scrape
  or the 700+ row payout export every 15 min. Takes ~2-3 min.

Both have `concurrency` groups so overlapping runs don't pile up.

**Credentials live in GitHub Actions encrypted secrets**, reconstructed to
files at the start of each run (nothing sensitive is committed):
- `ENV_FILE` — the full local `.env` content
- `ACCOUNTS_JSON` — `data/accounts.json` (18 PixlerPay logins)
- `PAYNIX_MERCHANT_LOGINS` — `data/paynix-merchant-logins.json` (9 Paynix merchant logins)
- `GDRIVE_OAUTH_CLIENT` / `GDRIVE_OAUTH_TOKEN` — Drive OAuth (for uploads)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — for alerting

To update any of these (e.g. after adding a new merchant login), re-run
locally: `gh secret set <NAME> --repo rishav414-blip/pixlerpay-commission < <file>`.

**Important gotcha already hit and fixed**: a fresh GitHub Actions checkout
has no local disk memory of the previous run, so all the "what changed
since last time" diffing (wallet changes, new failed payouts, new load
requests) would silently produce zero results every single run if it only
looked at local files. Fixed via `scripts/lib/drive-fetch.js`, which falls
back to reading the *last published* snapshot from Drive (same public,
Drive-API-restricted key already embedded in `docs/index.html`, now also
in `.env` as `GOOGLE_DRIVE_API_KEY`) whenever no local snapshot exists.
This applies to `download-paynix.js`, `download-paynix-merchant-wallets.js`,
and `download-pixlerpay-merchant.js`.

**Also fixed**: `download-report.js` used to set a nonzero exit code if
*any* single PixlerPay account failed, which — chained with `&&` in
`npm run all` — silently blocked every downstream step (calculate, Paynix,
uploads, alerts) on every run, since N V CONNECT ACROSS's broken portal
fails predictably every time. Now only exits nonzero if *every* account
fails; a partial failure is logged but doesn't block the rest.

## Telegram alerts — live

Bot: **@payout_alert_autobot**. `scripts/telegram-alert.js` runs as the
last step of both workflows and sends (via the free Telegram Bot API):
- New failed payouts (Paynix reseller side, post rate-limit-noise filtering)
- Wallet balance changes (Paynix reseller side, aggregate delta)
- New wallet top-up ("Load Request") entries — both the 9 Paynix merchants
  and PixlerPay's own merchant account, diffed against the last published
  Drive snapshot (see the CI gotcha above)

No-ops cleanly (logs and exits 0) if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
aren't set — safe to run even before the bot exists.

## One command to refresh everything (still works locally too)

```powershell
npm run all
```

Runs, in order:
1. `download-report` — logs into each PixlerPay account in `data/accounts.json`, downloads payout CSVs into `data/`
2. `calculate` — matches transactions to `data/commission-rates.json` + `data/manual-transactions.json` (see Known Limitation #3), writes `website/commission-results.json` (includes per-transaction log for date-range filtering)
3. `download-paynix` — logs into Paynix reseller portal, scrapes dashboard/merchants/failed-payouts, writes `website/paynix-results.json`, diffs against the previous snapshot (local file, or Drive fallback) for wallet changes / new failures
4. `download-paynix-wallets` — logs into each of the 9 known Paynix merchant accounts (`data/paynix-merchant-logins.json`, gitignored), scrapes their top-5 wallet "Load Requests" log, merges into `website/paynix-results.json` under `walletLogs` + `newLoadRequests`
5. `download-pixlerpay-merchant` — logs into PixlerPay's own Paynix merchant account, exports full payout history (xlsx via the portal's Export button) + wallet log, computes flat-rate commission, writes `website/pixlerpay-merchant-results.json`
6. `upload-to-drive` — pushes all three JSON files to Drive (OAuth, fully unattended). The dashboard picks up changes automatically on its next fetch (every 5 min) or via its Refresh buttons — no redeploy needed.
7. `telegram-alert` — sends alerts for anything new found in steps 3-5.

Individual steps can also be run separately (`npm run download-report`, `npm run calculate`, `npm run download-paynix`, `npm run download-paynix-wallets`, `npm run download-pixlerpay-merchant`, `npm run upload-to-drive`, `npm run telegram-alert`).

## Credentials & config

- **PixlerPay logins:** `data/accounts.json` (gitignored) — 18 client name → username/password entries, imported from a Chrome password export.
- **Paynix reseller login:** in `.env` as `PAYNIX_USERNAME` / `PAYNIX_PASSWORD` (`info@qttap.com` / the shared reseller login).
- **Paynix per-merchant logins (9 of 13):** `data/paynix-merchant-logins.json` (gitignored) — found in two Chrome password export CSVs the user provided (`Personal calculation/Chrome Passwords_1.csv` and `_2.csv`, outside this repo), plus DATSHA SOLUTION PVT LTD (added directly by the user 2026-07-11, a merchant that joined the reseller network that day). Missing 4 — see Known Limitation #6.
- **PixlerPay's own Paynix merchant account:** in `.env` as `PIXLERPAY_MERCHANT_USERNAME` / `PIXLERPAY_MERCHANT_PASSWORD` (`info@pixlerpay.com`), found in the same CSVs — a login that didn't match any of the reseller merchant names, turned out to be PixlerPay's own direct merchant account (700+ payouts, tens of lakhs in wallet balance).
- **Google Drive OAuth:** `data/gdrive-oauth-client.json` (Desktop OAuth client, downloaded from Cloud Console) + `data/gdrive-oauth-token.json` (refresh token, generated by `npm run gdrive-oauth-setup`, authorized as `rishav414@gmail.com`). Both gitignored.
- **Drive file IDs** (pinned in `.env` so re-uploads update in place, never duplicate):
  - `GOOGLE_DRIVE_RESULTS_FILE_ID=1pdZcZgvghRuSZ2K8OqhHRiX-oLsKIMNm` (PixlerPay)
  - `GOOGLE_DRIVE_PAYNIX_FILE_ID=1QNBL16ZKs0IJ2TptujnazLSk29SGxVEy` (Paynix)
  - `GOOGLE_DRIVE_PIXLERPAY_MERCHANT_FILE_ID=1gCWH8z9GQpnl2vdgx9fpbg7yOHyPD6E-` (PixlerPay Merchant)
- **Drive API key** (client-side, restricted to Drive API only, embedded in `docs/index.html` AND now in `.env` as `GOOGLE_DRIVE_API_KEY` for server-side previous-snapshot fallback reads): `AIzaSyDPHDn4LMUeTn3Ios3RsZgB2P_2Bz8o9gU`
- **Telegram bot:** `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` in `.env` — bot is @payout_alert_autobot, chat ID captured from the user's own DM to the bot.
- **GitHub:** authenticated as `rishav414-blip` via `gh auth login` (already done on this machine). Also has `workflow` scope, needed to push changes to `.github/workflows/*.yml`.
- **GitHub Actions secrets:** mirror of the above, set via `gh secret set` — see "Automation" section above for the full list and how to update them.

## Architecture notes / decisions made along the way

- **Commission logic differs by platform:** PixlerPay commission = margin (Onboarded % − Reseller %) calculated by us; Paynix reseller commission is read directly from their dashboard (they compute it); PixlerPay's own merchant account uses a separate flat rule (0.05% above ₹1000, flat ₹1 at/below) per explicit user instruction — not the margin model.
- **PixlerPay reports have no VA/client column** — each login is already scoped to one client, so matching is by account→client name, not per-row VA.
- **Service accounts don't work for personal Gmail Drive uploads** — no storage quota outside Google Workspace Shared Drives. Switched to OAuth against the actual Google account instead (see `scripts/gdrive-oauth-setup.js`).
- **GitHub Pages requires a public repo** on the free plan (private repos need GitHub Pro for Pages) — repo was switched to public since data privacy wasn't a concern for this use case. This also happens to make GitHub Actions minutes unlimited/free, which is what made the scheduled-automation approach viable without a paid VM.
- **Artifact hosting (claude.ai) can't fetch external data** — its CSP blocks all outbound network requests, which is why the dashboard is hosted on GitHub Pages instead, not as a Claude Artifact.
- **Custom date-range filtering** works by shipping the full per-transaction log (`transactions: [[va, isoDate, amount], ...]`) to the browser, which recomputes aggregates client-side for whatever range is selected — not just the last-30-days snapshot. The PixlerPay Merchant tab has the same feature, filtering the raw `payouts` array by parsed `createdAt` date.
- **Wallet-change / failed-payout / new-load-request detection** works by diffing each Paynix snapshot against the previous run's snapshot — locally that's `data/paynix-snapshot-previous.json`; in CI (no local memory between runs) it falls back to the last snapshot published on Drive.
- **Merchant wallet "Load Requests" vs "Transaction History"**: the merchant wallet page has two separate tables. Wallet-log scraping specifically targets "Load Requests" (top-up requests, both pending and approved) by matching the "REQUEST ID" header text — an earlier version accidentally targeted "Transaction History" (the full debit/credit ledger) instead, which was wrong and has been corrected everywhere.
- **Gateway rate-limit noise filtered from failed payouts**: Paynix's "Please wait at least N minutes between transactions" gateway message is retry throttling, not a real failure — excluded via `RATE_LIMIT_REASON_RE` in `download-paynix.js` so it doesn't drown out genuine failures (which, once the noise was removed, turned out to often be "Low balance to make this request" — a real, actionable failure category).
- **Manual transaction override**: `data/manual-transactions.json` (git-tracked, not gitignored — it's a deliberate override, not a secret) lets a transaction be entered by hand for a client whose automation is currently broken. `calculate-commission.js` folds it into the same aggregation as scraped transactions.

## Known limitations / not-yet-done

1. **"Refresh" buttons on the dashboard only re-fetch the latest Drive snapshot** — they cannot trigger a brand-new live scrape synchronously on click, because GitHub Pages is a static site with no backend, and GitHub Actions workflows aren't instant/synchronous from a browser click. In practice this matters less now that the whole pipeline runs automatically every 15-30 min — but genuine "click → scrape happens right now, wait, see fresh data" still needs a real server (VM) or a more involved workflow-dispatch + polling setup.
   - **Status:** not built. A VM remains the option if true instant on-demand refresh is ever needed; the free GitHub Actions cron is the current tradeoff (frequent enough, not instant).
2. **N V CONNECT ACROSS PRIVATE LIMITED (PixlerPay)** — automation fails; its "DT and Payout" combined solution type has a different portal layout (the "Payouts Transaction" nav link isn't found, times out after 30s). Not fixed. Workaround: `data/manual-transactions.json` has one manual entry (₹50,00,000 on 2026-07-02 → ₹10,000 commission at 0.20% margin) added by the user; add more entries there in the same shape as needed.
3. **3 PixlerPay clients showed zero transactions** in an earlier scrape (Elleaura, FINFLEX, WESURE cybertech/infra/innovations) — flagged as worth a manual sanity check since they're marked Active/Onboarding in the rate sheet, but not investigated further.
4. **Paynix's aggregate "Wallet Change" column is still inferred from balance deltas** between runs (current − previous), not a real ledger — this is separate from (and coarser than) the per-merchant "Load Requests" log, which IS a real log for the 9 merchants with credentials.
5. **One pre-existing scraping quirk, not yet fixed**: at least one failed payout's `reason` field scraped as the literal string `"FAILED"` instead of a real gateway message — a minor regex miss in `scrapeFailedPayouts()`'s reason-extraction pattern. Low priority, cosmetic (doesn't affect the commission math), noticed while testing Telegram alert formatting.
6. **Only 9 of 13 Paynix merchants have merchant-portal logins** (`data/paynix-merchant-logins.json`, gitignored). Missing: APAS TECH POINT, PPAY SOLUTION, Global Books Trading, Define Enterprises. Their rows on the Paynix tab show no "Recent" wallet-log toggle since there's nothing to scrape. Add credentials in the same JSON shape (and update the `PAYNIX_MERCHANT_LOGINS` GitHub secret) to close the gap.

## Key files

```
pixlerpay-commission/
├── .env                          # local secrets (gitignored)
├── .env.example                  # template
├── .github/workflows/
│   ├── refresh.yml               # full pipeline, every 30 min + manual dispatch
│   └── wallet-alert.yml          # Paynix-only fast path, every 15 min + manual dispatch
├── data/
│   ├── accounts.json             # PixlerPay logins (gitignored)
│   ├── commission-rates.json     # rate card from the Google Sheet (25 clients)
│   ├── manual-transactions.json  # hand-entered transactions for broken-automation clients (git-tracked)
│   ├── paynix-merchant-logins.json  # 9 Paynix merchant logins (gitignored)
│   ├── gdrive-oauth-*.json       # Drive OAuth credentials (gitignored)
│   ├── paynix-snapshot.json      # latest Paynix scrape (gitignored)
│   ├── paynix-snapshot-previous.json  # prior run, for local diffing (gitignored)
│   └── pixlerpay-merchant-snapshot.json  # latest PixlerPay-merchant scrape (gitignored)
├── docs/
│   └── index.html                # the live dashboard (GitHub Pages source), 3 tabs
├── scripts/
│   ├── download-report.js        # PixlerPay: login + download payout CSVs (18 accounts)
│   ├── calculate-commission.js   # PixlerPay: margin calculation + manual entries
│   ├── download-paynix.js        # Paynix reseller: login + scrape + diff
│   ├── download-paynix-merchant-wallets.js  # Paynix: 9 merchant wallet "Load Requests" logs
│   ├── download-pixlerpay-merchant.js  # PixlerPay's own Paynix merchant account
│   ├── telegram-alert.js         # sends alerts for anything new, via Telegram Bot API
│   ├── upload-to-drive.js        # push all results JSONs to Drive (OAuth)
│   ├── gdrive-oauth-setup.js     # one-time OAuth consent flow
│   ├── import-accounts.js        # one-time Chrome password CSV → accounts.json
│   └── lib/drive-fetch.js        # shared: read-only Drive fetch for CI's previous-snapshot fallback
├── website/
│   ├── commission-results.json   # PixlerPay output (gitignored, uploaded to Drive)
│   ├── paynix-results.json       # Paynix output (gitignored, uploaded to Drive)
│   └── pixlerpay-merchant-results.json  # PixlerPay-merchant output (gitignored, uploaded to Drive)
└── README.md                     # setup instructions (Drive sync, OAuth, etc.)
```

## If picking this up fresh

Read `README.md` for setup steps (already completed on this machine, but
useful if setting up elsewhere). This file (`HANDOFF.md`) is the "what's
been decided and why" companion — check both. Also check
`.github/workflows/*.yml` and the GitHub Actions run history for the
current state of the automation.
