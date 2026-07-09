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

## Google Drive sync + live dashboard

The hosted dashboard is live at **https://rishav414-blip.github.io/pixlerpay-commission/**.
It fetches `commission-results.json` (which includes a per-transaction log
so the page can filter by any custom date range) directly from a Google
Drive file on every load, auto-refreshing every 5 minutes.

**Auth note:** uploads use OAuth against your own Google account, not a
service account — service accounts have no storage quota on personal
Gmail accounts (only Google Workspace Shared Drives support that), so they
can't create/update files here.

### One-time OAuth setup

1. Same GCP project as before (or a new one) → **APIs & Services →
   Credentials → Create Credentials → OAuth client ID**.
2. If prompted, configure the consent screen first: User type **External**,
   fill in app name + your email as support/developer contact. Under
   **Audience**, set Publishing status to **In production** (this avoids
   Google's 7-day refresh-token expiry that applies to apps left in
   "Testing" mode — no verification is required since we only request
   Drive access for your own single account).
3. Application type: **Desktop app**. Any name. Create → **Download JSON**.
4. Save that file as `data/gdrive-oauth-client.json`.
5. Run:
   ```
   npm run gdrive-oauth-setup
   ```
   This opens your browser for a one-time Google sign-in/consent, then
   saves a refresh token to `data/gdrive-oauth-token.json` (gitignored).
   After this, `npm run upload-to-drive` works unattended indefinitely.

### Running

```
npm run upload-to-drive
```
Updates the existing `commission-results.json` Drive file in place (its ID
is pinned in `.env` as `GOOGLE_DRIVE_RESULTS_FILE_ID`, so re-runs always
update the same file rather than creating duplicates). Add it to `npm run
all` for a single end-to-end command:
```
npm run download-report && npm run calculate && npm run upload-to-drive
```
