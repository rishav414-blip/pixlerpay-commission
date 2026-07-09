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

## Google Drive sync (one-time setup)

`npm run upload-to-drive` pushes `website/commission-results.json` to a
Google Drive folder after every calculation, so the hosted web dashboard can
read live data instead of a frozen snapshot. This uses a **service
account** — a robot Google identity separate from your personal login, so
it never expires and needs no re-authorization.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   create a new project (or reuse one).
2. In "APIs & Services" -> "Library", enable the **Google Drive API**.
3. In "APIs & Services" -> "Credentials" -> "Create Credentials" ->
   **Service account**. Give it any name (e.g. `pixlerpay-uploader`).
4. Open the new service account -> "Keys" tab -> "Add Key" -> "Create new
   key" -> JSON. This downloads a `.json` key file.
5. Save that file as `data/gdrive-service-account.json` in this project
   (already gitignored — never commit it).
6. In Google Drive, create a folder for the dashboard data (e.g.
   "PixlerPay Commission Data"). Right-click -> Share -> paste the service
   account's email (looks like `pixlerpay-uploader@your-project.iam.gserviceaccount.com`,
   found on the service account's details page) -> give it **Editor** access.
7. Open that folder in Drive, copy the folder ID from the URL:
   `https://drive.google.com/drive/folders/`**`THIS_PART_IS_THE_ID`**
8. In `.env`, set:
   ```
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./data/gdrive-service-account.json
   GOOGLE_DRIVE_FOLDER_ID=<the folder ID from step 7>
   ```
9. Run `npm run upload-to-drive` (or `npm run all` to do everything in
   sequence). The first run creates `commission-results.json` in that Drive
   folder and prints its **file ID** — save that, the hosted dashboard needs
   it to know which file to fetch.

Also create a **Drive API key** (separate from the service account) so the
hosted dashboard page can read the file client-side:

10. Same GCP project -> "Credentials" -> "Create Credentials" -> **API key**.
11. Click the new key -> "Restrict key" -> under "API restrictions" choose
    "Restrict key" and select only **Google Drive API**. Save.
12. Give me this API key + the `commission-results.json` file ID from step 9
    and I'll wire them into the hosted dashboard so it fetches live data on
    every page load.
