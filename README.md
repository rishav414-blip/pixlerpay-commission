# PixlerPay Commission Dashboard

Automates: login to PixlerPay merchant portal -> download payout report -> calculate commission per client (based on the Google Sheet rates) -> display on a local dashboard.

## One-time setup

```
cd pixlerpay-commission
npm install
npx playwright install chromium
copy .env.example .env
```

Copy `data/accounts.example.json` to `data/accounts.json` and add one entry
per client, using the client's real login username/password. Use the exact
**client name** (matching `commission-rates.json`'s `clientName`) as the
`name` field — do not use the old "Client ID" merged grouping from the
sheet. `data/accounts.json` stays local and is gitignored — never share or
commit it.

## Running

```
npm run download-report   # logs into each account in data/accounts.json, downloads its payout report into ./data
npm run calculate         # matches report rows to commission-rates.json (by VA, falling back to client name), writes website/commission-results.json
```

Or both in sequence: `npm run all`

Every run saves two copies of each account's report:
- `data/<client>-payout-report.csv` — the "latest" copy, overwritten each run, read by `npm run calculate`.
- `data/raw-reports/<run-timestamp>/<client>-payout-report.csv` — an archived, never-overwritten copy of every run, so you can manually open and cross-check the raw numbers at any point.

### Customizing the report date range

By default the report covers the **last 30 days**. Override it with either:

- `.env`: set `REPORT_DAYS=7` (last 7 days), or set `DATE_FROM`/`DATE_TO`
  explicitly (`YYYY-MM-DD`) which takes priority over `REPORT_DAYS`.
- CLI flags, which override everything in `.env` for a one-off run:
  ```
  npm run download-report -- --days=7
  npm run download-report -- --from=2026-06-01 --to=2026-06-30
  ```

Then open `website/index.html` in a browser (or serve the folder) to see the dashboard.

## Adjusting column matching

`scripts/calculate-commission.js` auto-detects report columns (VA, amount,
status, etc.) by common header names. If your report uses different headers,
edit `COLUMN_ALIASES` in that file to add them.

## Updating commission rates

`data/commission-rates.json` mirrors the Google Sheet. If the sheet changes,
update this file to match (or ask me to re-sync it).

## Scheduling (optional)

To run this automatically on a schedule, use Windows Task Scheduler to run:
`npm run all` inside this folder, e.g. daily at 9am.

## Google Drive sync + live dashboard (status: working, semi-automated)

The hosted dashboard is live at **https://rishav414-blip.github.io/pixlerpay-commission/**.
It fetches `commission-results.json` directly from a Google Drive file on
every page load (and auto-refreshes every 5 minutes), using a
Drive-API-restricted API key embedded in `docs/index.html`.

**Known limitation:** `npm run upload-to-drive` (via
`scripts/upload-to-drive.js`) does not work — Google service accounts have
no storage quota on personal Gmail accounts (only Google Workspace Shared
Drives support this), so unattended local uploads aren't possible without
a Workspace account. `data/gdrive-service-account.json` and the
`GOOGLE_SERVICE_ACCOUNT_KEY_FILE/GOOGLE_DRIVE_FOLDER_ID` env vars are kept
for reference but unused.

**Current workflow to refresh the live dashboard:**
1. Run `npm run all` locally (downloads reports, calculates commission,
   writes `website/commission-results.json`).
2. Ask Claude to "push the latest results" — it has its own Google Drive
   connection to this account and updates the same Drive file directly
   (file: `commission-results.json` inside the "PixlerPay Commission Data"
   Drive folder). The GitHub Pages dashboard picks up the change on its
   next fetch/refresh — no redeploy needed.

If you want this fully unattended (no manual "push the latest results"
step), the fix is switching from a service account to OAuth using your own
Google account (one-time browser consent, refresh token stored locally) —
ask Claude to set this up if needed later.
