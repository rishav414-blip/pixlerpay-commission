# Handoff — PixlerPay / Paynix Commission Dashboard

Last updated: 2026-07-17 (Paynix commission cross-check report + reseller rate change to 0.70%, see below)

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
  **Added 2026-07-13**: now also exports full payout history from the same
  9 Paynix merchant portals (`download-paynix-merchant-reports`, for the
  margin+AK commission calc) — some of these accounts have thousands of
  payouts (DIGIROUTE ~9.5k, Sunshine Global ~5.5k, Curiobyte ~6k), so this
  likely pushes total runtime noticeably past the ~5-10 min figure above.
  Not yet re-measured against real CI run history — worth checking after a
  few scheduled runs, and reconsidering whether this belongs in the
  30-min `refresh.yml` vs a slower/separate schedule if it's making the
  already-unreliable `schedule` cadence (see below) worse.
- **`.github/workflows/wallet-alert.yml`** — every 15 min (`*/15 * * * *`)
  + manual dispatch. Fast path scoped to just the Paynix side (reseller
  scrape + 9 merchant wallet logs) so new wallet top-up requests get
  alerted on quickly without re-running the slow 18-account PixlerPay scrape
  or the 700+ row payout export every 15 min. Takes ~2-3 min.

Both have `concurrency` groups so overlapping runs don't pile up.

**⚠ Diagnosed 2026-07-12: GitHub's `schedule` trigger does not honor the
configured interval.** Measured against real run history (00:00-07:16 UTC
that day): `refresh.yml` (every 30 min configured) actually fired **2
times** (~13% of the ~15 expected); `wallet-alert.yml` (every 15 min
configured) fired **3 times** (~10% of the ~29 expected). Real gaps
between runs were 55-75 min typically, up to 3.5 hours overnight. This is
GitHub Actions' documented best-effort behavior for `schedule` events —
not a bug in these workflow files, and not a disabled-workflow issue
(confirmed both `state: active` via `gh api .../actions/workflows`).
Telling evidence: every *manual*/API-triggered dispatch during setup and
testing started within ~9 seconds — only `schedule`-triggered runs are
delayed, so `workflow_dispatch` itself is reliable, the internal cron
queue is what's throttled.

**Fix in progress, chosen approach**: an external free cron service
(cron-job.org) calling GitHub's REST API to trigger `workflow_dispatch`
on a real schedule, bypassing GitHub's internal `schedule` queue entirely
(dispatch-triggered runs are not subject to the same delay). Requires:
1. A fine-grained GitHub PAT scoped to only this repo, only
   `Actions: Read and write` (created via
   github.com/settings/tokens?type=beta, not yet done as of this writing).
2. Two cron-job.org jobs (free account, not yet created as of this
   writing), each a `POST` to
   `https://api.github.com/repos/rishav414-blip/pixlerpay-commission/actions/workflows/<workflow-file>/dispatches`
   with header `Authorization: Bearer <PAT>` and body `{"ref":"master"}`
   — one per workflow, at 15-min and 30-min intervals respectively.
3. Once confirmed firing reliably, the `schedule:` blocks in both
   workflow YAML files can be removed (or left as a redundant fallback —
   harmless either way since they're additive, not conflicting).

**Until that's done**, treat the real cadence as "roughly hourly,
sometimes much longer overnight" rather than 15/30 min — this affects how
fresh the dashboard data and alerts actually are day to day.

**Known side-effect of the above, not yet fixed**: the dashboard's
"stale" badge threshold (`docs/index.html`, `STALE_THRESHOLD_MS`) is set
to 20 minutes, which assumed the configured 15/30 min cadence would
roughly hold. Given the real ~60-90+ min cadence, the badge now shows
"stale" most of the time even when the pipeline is behaving normally.
Should be raised (e.g. to 90 min) or reconciled once the external-cron fix
lands and real cadence is known.

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

## Periodic PixlerPay commission Excel report (recurring, every ~10 days)

The client wants a formatted Excel commission report for PixlerPay only,
covering a rolling window (first requested: 1st-10th July; will recur for
each subsequent ~10-day period). It must visually match their own
reference sheet exactly: title row merged across all columns ("Volume
<start> to <end>"), green header row with wrapped labels, thin borders on
every cell, yellow-highlighted Commission column, bold Total row.

**One command does the whole thing:**

```powershell
npm run commission-report -- <START:YYYY-MM-DD> <END:YYYY-MM-DD> [outputPath]
# example for the next cycle:
npm run commission-report -- 2026-07-11 2026-07-20
```

Script: `scripts/generate-commission-report.cjs`. What it does:

1. **Fetches live per-transaction data straight from Drive**
   (`GOOGLE_DRIVE_RESULTS_FILE_ID` + `GOOGLE_DRIVE_API_KEY` from `.env`) —
   deliberately does NOT read local `website/commission-results.json` or
   `data/*.csv`, because those only reflect whatever was last downloaded
   to this machine and go stale between automated runs (this bit the
   first version of this report: local copy was 3 days stale and silently
   missing a client's transactions/showing a lower total than the live
   dashboard).
2. Filters the `transactions: [va, isoDate, amount]` array to the given
   date range (inclusive).
3. Recomputes commission **per transaction**, replicating
   `scripts/calculate-commission.js`'s exact rule: percentage margin
   (`onboardedPct - resellerPct`) on the amount, EXCEPT a flat-rate
   override (`onboardedFlat100to200 - resellerFlat100to200`) for any
   transaction with `100 <= amount <= 200`. **This must stay in sync with
   `calculate-commission.js` if that file's logic ever changes** — an
   earlier version of this report used `totalVolume × marginPct` (ignoring
   the flat-band override) and came out ~₹3,300 short of the live
   dashboard's total for the same range; per-transaction recomputation is
   what reconciled it exactly.
4. Flags any client whose VA isn't in the hardcoded `ORIGINAL_VAS` set
   (the 13 VAs from the client's very first reference sheet) with
   `" (New Client)"` appended to their name — this is how "check if a new
   client has been added" gets answered going forward. **Update
   `ORIGINAL_VAS` in the script if the client ever re-baselines what
   counts as already-known** (otherwise every already-flagged client will
   keep showing "(New Client)" forever).
5. Writes the formatted `.xlsx` via `exceljs` (not the `xlsx` package —
   `xlsx`'s free/community build cannot write cell colors/borders/merges,
   which is why `exceljs` was added as a dependency specifically for this
   script).
6. Default output path is
   `../PixlerPay_Commission_<START>_to_<END>.xlsx` (i.e. one level up,
   in `Personal calculation/`, sibling to this repo folder) — pass a
   third argument to override.

**Known gotcha**: if the target `.xlsx` is open in Excel when the script
runs, the write fails with `EBUSY: resource busy or locked` — close the
file first.

**Data freshness caveat**: the report is only as fresh as the last
successful pipeline run feeding Drive (see the Automation section above
for why that cadence is currently unreliable, ~hourly/worse overnight,
not the configured 15/30 min). If a requested end date is more recent
than the latest transaction in the live snapshot, the script logs a
warning naming the actual latest date available — check that warning
before treating the report as covering the full requested range.

### Extra columns: "Commission by client" / "NXT commission"

Added 2026-07-12 after the client manually edited a generated report and
added these two columns by hand. **This is a per-client mapping, not a
rate-tier formula** — reverse-engineered by tabulating which specific
clients had a value filled in, matching the ratio of that value to their
volume, and confirming with the client that this exact per-client mapping
(not a blanket "same onboarded rate = same treatment" rule) is what to
keep applying:

- `COMMISSION_BY_CLIENT_VAS` (SAM255 WESERV, SAM256 SERVM, SAM288 Emervex,
  SAM295 Curiobyte) → **Commission by client** = volume × 0.20% if their
  onboarded rate is 1.30%, or volume × 0.10% if 1.10%.
- `NXT_COMMISSION_VAS` (SAM286 RASHEEYA, SAM298 N V CONNECT, SAM299
  BITNEXY, SAM328 GLOBAL BOOKS, SAM338 SOSHY, SAM348 PPAY, SAM358 suvika)
  → **NXT commission** = volume × 0.10% if their onboarded rate is 1.20%.
- Every other client (EIENON, SRKA, DATSHA, XPASSPHERE, and any future
  client not in either set above) → **both columns blank**, even if their
  onboarded rate matches one of the tiers above. This was confirmed
  deliberately — do not "fill the gaps" by applying the tier rule
  universally, that was tried and explicitly rejected.
- **If a new client needs one of these columns**, add their VA to the
  right set in **both** `scripts/generate-commission-report.cjs` and the
  `docs/index.html` download-button script (kept as two separate
  hardcoded copies since the browser can't `require()` the Node script —
  they must be edited together).
- What these two columns actually represent (which downstream party
  "client" and "NXT" are) was never explained by the client — just
  treated as a fixed formula per their instruction. If it ever needs to
  change, ask what the columns mean before touching the mapping.

## Download Excel button (PixlerPay tab, docs/index.html)

Lets the user generate the same formatted report as
`generate-commission-report.cjs` directly from the browser, for whatever
From/To range is currently selected on the PixlerPay tab — no server
round-trip, no separate scrape triggered.

- Uses `ExcelJS` loaded via CDN (`<script src="https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js">`
  in `<head>`) since GitHub Pages is a real website (unlike a Claude
  Artifact) and external requests aren't CSP-blocked here. The free `xlsx`
  package can't do cell colors/borders, which is why this needed a
  different library than what's used elsewhere for CSV parsing.
- **Reuses the page's existing Drive-fetched `DATA`** (the same
  `fetchData()`/`computeForRange()` the table already uses) — does NOT
  trigger any new backend scrape or fetch. This was a deliberate
  correction: an earlier version of this feature accidentally kicked off
  a full local `npm run all` pipeline run when wiring this up, which the
  client explicitly said not to do — "use the existing drive process
  only."
- **Data-availability guard**: before generating, compares the selected
  `rangeTo` against the latest transaction date actually present in
  `DATA.transactions`. If the range extends past what's been scraped, it
  shows a red error banner (`#downloadError`) explaining what's missing
  and suggesting Refresh — it does not silently generate a partial/wrong
  report. Same check for `rangeFrom` being earlier than the earliest
  available data.
- Mirrors `generate-commission-report.cjs`'s exact column set, formatting,
  and the "Commission by client"/"NXT commission" per-client mapping
  above — **the two are hand-kept in sync**, there's no shared module
  between the Node script and the browser script.
- `computeForRange()` (used by both the table and the download) had a gap
  fixed alongside this: it wasn't carrying `resellerFlat100to200` /
  `onboardedFlat100to200` through from `DATA.clients`, which would have
  made the "Sumeet(reseller) Pricing below 1000" / "Onboarded Pricing for
  100-200" columns blank in every downloaded file. Fixed by adding those
  two fields to the per-client aggregate object.

## Paynix commission (margin + AK), added 2026-07-13

The Paynix tab originally only showed wallet balance + the single
aggregate `lifetimeCommission` Paynix itself reports (no math needed, no
per-client breakdown). The client provided their own rate card for Paynix
(Google Sheet, not this repo) with per-client Sumeet/Onboarded rates plus
a new **AK%** — a separate downstream-partner cut, analogous to margin
commission but always a flat percentage of amount (no 100-200 flat-band
override defined for AK). This required real new backend data collection,
not just UI work — the reseller dashboard never exposed per-merchant
transaction volume, only wallet balance/status.

**New data files:**
- `data/paynix-commission-rates.json` — all 26 clients from the client's
  sheet (Sumeet%, Sumeet-flat, Onboarded%, Onboarded-flat, AK%, and a
  `group` field for reference only — the sheet's "[merged] X" labels are
  AK-settlement groupings, not Paynix account merges; each client with a
  `merchantId` already has its own individual Paynix merchant account).
  13 of 26 clients have no `merchantId` — either not yet live on Paynix,
  or a name that didn't match any of the 13 active merchant records
  scraped from the reseller dashboard (matched by hand, not fuzzy-matched
  — if a client's Paynix account goes live, add their `merchantId` here
  manually by cross-checking `website/paynix-results.json`'s `merchants`
  array).
- `data/paynix-merchant-reports/<merchantId>.json` — full payout history
  per merchant (gitignored), from the new scraper below.
- `website/paynix-commission-results.json` — calculated output (Drive
  file ID `GOOGLE_DRIVE_PAYNIX_COMMISSION_FILE_ID` in `.env`, also
  hardcoded as `PAYNIX_COMMISSION_FILE_ID` in `docs/index.html`).

**New scripts:**
- `scripts/download-paynix-merchant-reports.js` (`npm run
  download-paynix-merchant-reports`) — logs into each of the 9 known
  individual merchant portals (`data/paynix-merchant-logins.json`) and
  exports full payout history via the portal's own Export button —
  **deliberately not** scraping the reseller portal's per-client filtered
  view, since that portal has no export and would mean paginating through
  13 merchants' transaction tables on every refresh (fragile, slow — the
  same category of problem that already broke N V CONNECT's PixlerPay
  scrape). Confirmed with the client this is the right tradeoff.
  Covers 9 of 13 rate-card clients with a known Paynix account; the
  other 4 (APAS TECH POINT, PPAY SOLUTION, Global Books Trading, Define
  Enterprises — same gap as PixlerPay-side limitation #7) have no
  merchant-portal login yet, so show "no data available" rather than a
  silent zero.
- `scripts/calculate-paynix-commission.js` (`npm run calculate-paynix`) —
  joins the reports to the rate card, computes margin commission (same
  percentage-with-100-200-flat-band-override rule as
  `calculate-commission.js`) **and** AK commission per transaction, writes
  a `transactions: [merchantId, isoDate, amount]` log for client-side
  date-range recompute. Any rate-card client with no `merchantId` or no
  report file gets `hasData: false` instead of being computed as zero.
- Both wired into `npm run all` (after `download-paynix-wallets` /
  `download-pixlerpay-merchant`, before `upload-to-drive`) and into
  `upload-to-drive.js` as a 4th upload target.

**Dashboard (Paynix tab) changes:**
- Added From/To range filters (same UX as the PixlerPay tab), wired to a
  new "Commission by Client" table showing Volume / Commission / AK
  Commission / Wallet Balance / Wallet Change / Status per client —
  replacing the old wallet-only table. `computePaynixCommissionForRange()`
  / `computePaynixCommissionForMerchant()` in `docs/index.html` mirror
  `calculate-paynix-commission.js`'s math client-side (kept in sync by
  hand, same pattern as the PixlerPay tab's `computeForRange()`).
- Added a **Download Excel** button, same data-availability guard pattern
  as the PixlerPay one, with columns for AK% and AK Commission (yellow =
  margin commission, blue = AK commission, in both the live table styling
  intent and the exported file). Clients with no data show as an
  italicized "(no data available)" row in the export rather than being
  silently dropped, so the client can see the coverage gap.
- **Removed the per-row "Recent ▾" wallet-log dropdown toggle** (was one
  expand/collapse per merchant row) and replaced it with a single
  consolidated **"Recent Wallet Top-Ups — All Clients"** table below the
  commission table — all merchants' `walletLogs` entries pooled into one
  list, sorted by date descending, with a Client column added to
  distinguish rows. Per the client's explicit request: "find another way
  to show the collated data for all clients in 1 section."

**Still open / not done:**
- The 13 rate-card clients without a `merchantId` (WESURE, WESERV,
  Elleaura, EIENON, SRKA, SOSHY, INDILOXY, N V CONNECT, XPASSPHERE,
  RUSTIC ODYSSEYS, FINFLEX, Harmonious, and one of the two Global
  Books/PPAY-type near-duplicates if a name mismatch was missed) show "no
  data available" everywhere. Close this by adding their `merchantId` once
  live on Paynix, or their merchant-portal login if only 4 are truly
  missing logins.
- The sheet's per-client notes ("0.1% above this", "Base rate as 0.9%",
  "divided by 3", "by 3", "all own", "by 2") were explicitly told to be
  ignored by the client — not encoded anywhere. If that changes, ask what
  they mean before implementing (same caution as the PixlerPay "Commission
  by client"/"NXT commission" columns — these tend to be manual
  downstream-settlement logic, not simple formulas).
- `GOOGLE_DRIVE_PAYNIX_COMMISSION_FILE_ID` was added to local `.env` but
  **not yet mirrored into the GitHub Actions `ENV_FILE` secret** — until
  that's updated (`gh secret set ENV_FILE --repo rishav414-blip/pixlerpay-commission < .env`),
  the automated CI pipeline will keep re-creating a NEW Drive file each
  scheduled run instead of updating this one in place (same footgun the
  "known file ID" pattern elsewhere in this file exists to avoid). Also
  needs a new `PAYNIX_MERCHANT_LOGINS`-style secret check — actually reuses
  the existing `PAYNIX_MERCHANT_LOGINS` secret already set for wallet
  scraping, no new secret needed there.

## Paynix commission cross-check report, added 2026-07-17

A one-off (not scheduled/automated) report comparing our own calculated
margin commission per SUCCESS payout against what Paynix actually
credited, matched via the reseller portal's own wallet ledger. First
built ad-hoc in an earlier session and never saved anywhere — the output
file (`Paynix_Commission_CrossCheck_12th July.xlsx`, one level up from
this repo) existed but there was no script behind it. Rebuilt properly
this session with reusable scripts:

- `scripts/fetch-reseller-ledger-range.mjs <FROM> <TO> <outFile>` — logs
  into the **reseller** portal (`PAYNIX_USERNAME`/`PAYNIX_PASSWORD`) and
  paginates `GET /api/v1/reseller/portal/wallet/transactions`
  (`localStorage.paynix_access_token` bearer auth, same technique as the
  merchant-report scripts) newest-first until entries fall below `FROM`,
  filtering to `[FROM, TO]`. This endpoint — and the whole idea that the
  reseller-side wallet ledger carries a `COMMISSION`-category, per-payout
  breakdown (`referenceType: PAYOUT_TXN`, `referenceId: <payoutId>`) — was
  previously undiscovered/undocumented; found via a network-request probe
  clicking the "Wallet" nav item in the reseller dashboard. Not part of
  `npm run all` — this ledger isn't otherwise scraped anywhere.
- `scripts/fetch-merchant-payouts-range.mjs <FROM> <TO> [outDir]` — same
  per-merchant-portal API as `download-paynix-merchant-reports.js`, but
  for an arbitrary explicit date range instead of the rolling
  `FETCH_WINDOW_DAYS`. Needed because the regular incremental scrape only
  keeps a few days locally between runs (the 30-day retention lives in
  the *merged* Drive snapshot, not in these raw per-merchant report
  files) — reconstructing a specific historical range (e.g. "1st-15th
  July") requires re-fetching it directly from each portal.
- `scripts/generate-paynix-crosscheck.cjs <FROM> <TO> <reportsDir>
  <ledgerFile> <outPath>` — joins payouts to ledger entries by
  `payoutId === referenceId`, recomputes our commission per transaction
  using the **exact same** `calcMarginCommission` as
  `calculate-paynix-commission.js` (keep in sync if that changes), and
  writes a 3-sheet `.xlsx`: **Summary** (per-merchant match rate/volume/
  commission totals), **All Transactions** (every SUCCESS payout with
  matched/unmatched status and the diff), **Paynix Wallet Ledger (raw)**
  (the raw COMMISSION entries, for manual spot-checking).
- Only covers the 9 merchants with known portal logins (same gap as
  limitation #7) — the 4 without logins are skipped, not shown as zero.
- Output files are one level up from this repo
  (`../Paynix_Commission_CrossCheck_<range>.xlsx`), not committed. The
  scripts and rate card are committed; the raw per-run data dumps
  (`data/paynix-merchant-reports-range/`, `data/reseller-ledger-*.json`)
  are gitignored.

**Rate card changed 2026-07-17**: client dropped the "Sumeet (reseller)"
pricing to a flat **0.70%** for every client (was 0.75%/0.80% depending
on group) — sourced from the actual Google Sheet this time
(`docs.google.com/spreadsheets/d/124ZZg6E98XyQ882t5BeNSF4ng3KWceQJmCYX0H0kIW8`,
read via the Google Drive MCP connector's `read_file_content`, not
previously linked anywhere in this repo — worth remembering that URL for
next time the sheet changes). Onboarded %, flat-below-1000 rupee values,
and AK% were unchanged. Verified correct by generating the cross-check
report for 1st-15th July with the new rate: "Our Commission" now matches
Paynix's actual wallet-credited commission almost exactly per merchant
(e.g. suvika: both sides ₹210.21) — confirming 0.70% is what Paynix is
really crediting against, not just a plausible guess.

**Footgun hit while doing this, now understood**: `upload-to-drive.js`
unconditionally pushes **all four** `website/*.json` files every time
it's run, not just whichever one you changed. Running it manually to
push a Paynix-only fix pushed the *local* copies of the other three
files too — which were stale (last generated 2026-07-14 in this case)
because only the Paynix scripts had been run locally that session. This
overwrote fresher data that the scheduled CI pipeline had put on Drive
for PixlerPay, Paynix reseller/wallets, and PixlerPay's own merchant
account. **Recovered by re-running `download-report` + `calculate`,
`download-paynix`, and `download-pixlerpay-merchant` locally before the
next `upload-to-drive`** so all four files were genuinely fresh at upload
time. **Lesson: before running `upload-to-drive.js` manually (outside
the full `npm run all` chain), check `ls -la website/*.json` timestamps
first** — if any of the three you're not actively working on look stale,
refresh them too (or run the full `npm run all` instead of a partial
manual sequence) rather than letting a partial local state clobber
Drive's freshest copy of an unrelated tab's data.

**Separately, a genuine race hit while landing the rate change**: pushed
the rate-card commit to git, but a scheduled `refresh.yml` CI run had
already started (and finished) *before* the push landed, so it
recalculated and re-uploaded Paynix commission using the still-old
committed rate card, overwriting the fix that had just been uploaded
manually. Fixed by re-running `calculate-paynix` + `upload-to-drive`
locally *after* confirming the git push had landed. **If a rate/config
change needs to show up live immediately, land the git commit first,
then do the manual recalculate+upload — and check `gh run list` to make
sure no scheduled run is sitting mid-flight between the two**, since a
run that started before your commit lands will silently use the old
values and can overwrite a same-day manual fix.

## Incremental fetch + 30-day retention, added 2026-07-14

Every scrape script used to do a **full re-fetch + full recompute** on
every single run — no merging, no pruning. This caused two real problems:
runs got slower over time as account histories grew (some Paynix merchants
had 9,000+ lifetime payouts re-exported every 15-30 min), and there was no
retention limit anywhere — the dashboard shipped the *entire* history to
the browser forever.

**Also found and fixed while building this**: GitHub Actions had been
failing on literally every scheduled run for ~2 days before this (see the
`npm ci` / `package-lock.json` incident below) — the incremental rework
happened right after diagnosing and fixing that, so double-check CI run
history if data ever looks stale again.

**The pattern, applied to all three payout data sources** (PixlerPay's 18
client accounts, Paynix's 9 merchant accounts, PixlerPay's own merchant
account):

1. **Fetch only a recent window** each run (`FETCH_WINDOW_DAYS` /
   `REPORT_DAYS`, default 3 days — a safety margin beyond the 15/30-min run
   cadence so a missed/delayed run can't create a gap), instead of the full
   history or a full 30-day window every time.
2. **Merge against the previously published Drive snapshot**, deduped by a
   stable ID (PixlerPay: the CSV's own `Transaction ID` column; Paynix:
   `payoutId`/`transaction_id`). The transaction tuple format grew a 4th
   element for this: `[va/merchantId, isoDate, amount, id]` (PixlerPay tab
   code in `docs/index.html` destructures `[va, isoDate, amount]` and
   safely ignores the extra element — no dashboard changes needed).
3. **Prune anything older than `RETENTION_DAYS` (30)** before recomputing
   aggregates. This is what makes "the dashboard only shows the last 30
   days" true everywhere — the underlying data itself is capped, so the
   dashboard's default full-range view naturally can't show more than 30
   days without any dashboard-side date-capping logic needed.

**Per-source specifics:**

- **PixlerPay** (`scripts/calculate-commission.js`): `REPORT_DAYS=3` in
  `.env` controls `download-report.js`'s fetch window. Merge/prune logic
  lives entirely in `calculate-commission.js` (fetches `previous` via
  `fetchPreviousFromDrive(GOOGLE_DRIVE_RESULTS_FILE_ID, ...)`, falls back
  to the local `website/commission-results.json` if Drive isn't
  reachable). Rows with no detectable Transaction ID column are dropped
  rather than merged (can't safely dedupe them).
- **Paynix merchant reports** (`scripts/download-paynix-merchant-reports.js`
  + `scripts/calculate-paynix-commission.js`): rewritten to hit the
  merchant portal's own authenticated JSON API directly
  (`GET https://api.paynix.co.in/api/v1/merchant/portal/transactions/payouts?from=...&to=...`,
  bearer token read from `localStorage.paynix_access_token` inside a
  `page.evaluate()` — same technique used for the reseller wallet
  ledger investigation) instead of clicking Export and downloading an
  xlsx — **much faster** (all 9 merchants in ~1.5 min vs several minutes
  before) since it skips the file-download round trip and only asks for
  the recent window in the first place. `PAYNIX_MERCHANT_FETCH_WINDOW_DAYS`
  env var overrides the 3-day default if needed.
- **PixlerPay's own merchant account**
  (`scripts/download-pixlerpay-merchant.js`): still uses the xlsx Export
  flow (richer fields — fee, GST, UTR, etc. — that aren't in the JSON API
  response), but now sets the portal's own date-filter inputs before
  clicking Export, narrowing to `PIXLERPAY_MERCHANT_FETCH_WINDOW_DAYS`
  (default 3) instead of exporting full lifetime history. Merge/prune
  happens in `run()` itself (this script doesn't have a separate
  `calculate-*` step).

**One-time migration gotcha hit and fixed**: the first run after adding
the 4th tuple element merged a previously-published UN-tagged snapshot
(3-element tuples, no ID) against a freshly-tagged fetch of the same
window — since untagged entries got synthetic positional keys that never
match a real ID, this **did not dedupe and nearly doubled the transaction
count** (85,769 → 171,548) before the bug was caught. Fixed by dropping
untagged legacy entries entirely on merge, relying on the fresh fetch's
window already covering the full retention period at the time of the
cutover (true then; wouldn't be safe if this pattern is ever reintroduced
elsewhere without the same fresh-covers-retention guarantee). **If you
ever see transaction counts roughly double after a data-format change,
suspect exactly this failure mode first.**

**Idle-client alerting made real**: `idleClients` in
`commission-results.json` was previously referenced by `docs/index.html`
but never actually populated by `calculate-commission.js` — dead code.
Now computed for real: any client with rate-card `status: "Active"` and
zero successful transactions in *this run's fresh scrape* (not the merged
30-day history — this is meant to catch "did this run's login/scrape
work," a different question from "does this client have recent volume").

## GitHub Actions `npm ci` failure — root cause and fix (2026-07-14)

Every scheduled run (`refresh.yml` every 30 min, `wallet-alert.yml` every
15 min) had been failing in ~13 seconds — instantly, before any scraping
ever started — for roughly 2 days. Diagnosed via `gh run view <id>
--log-failed`: `npm ci` requires `package-lock.json` to exactly match
`package.json`, and `exceljs` had been added to `package.json` via `npm
install --no-save` + a manual edit (2026-07-12, for the commission Excel
export feature) without ever regenerating the lockfile. Fixed by running a
plain `npm install` to resync it, committing the result. Confirmed fixed
via a manual `workflow_dispatch` run completing successfully end-to-end.

**Lesson**: never add a dependency via `--no-save` + manual `package.json`
edit in this repo again — always let `npm install <pkg>` update both
files together, or explicitly run a plain `npm install` afterward to
resync `package-lock.json` before committing.

Also refreshed while diagnosing this: the `ENV_FILE` / `ACCOUNTS_JSON` /
`PAYNIX_MERCHANT_LOGINS` GitHub secrets, whose timestamps looked stale
relative to recent local `.env`/`data/*.json` changes — re-run `gh secret
set <NAME> --repo rishav414-blip/pixlerpay-commission < <file>` any time
local credential files change, this is easy to forget and silently leaves
CI using outdated credentials/config.

## Telegram alerts — live

Bot: **@payout_alert_autobot**. `scripts/telegram-alert.js` runs as the
last step of both workflows and sends (via the free Telegram Bot API):
- New failed payouts (Paynix reseller side, post rate-limit-noise filtering)
- Wallet balance changes (Paynix reseller side, aggregate delta)
- New wallet top-up ("Load Request") entries — both the 9 Paynix merchants
  and PixlerPay's own merchant account, diffed against the last published
  Drive snapshot (see the CI gotcha above)
- **Added 2026-07-14**: a PixlerPay summary message (new txns + commission
  delta since the last alert, tracked in a small local
  `data/pixlerpay-telegram-previous.json` snapshot — not the full 85K+
  transaction file, just enough to diff) plus idle/failure alerts, using
  the newly-real `idleClients` and existing `skippedReports` fields.
  PixlerPay previously had zero Telegram alerts at all.

**Message format, added 2026-07-14** (per explicit request): wallet
top-up lines now include the entry's `createdAt` timestamp, and each
merchant's new-load-request list is capped to the **2 most recent**
entries (`MAX_WALLET_ENTRIES_PER_MERCHANT` in `telegram-alert.js`) with a
"…and N more" suffix if there were more — previously showed every new
entry uncapped.

**Wallet-log sort bug, fixed 2026-07-14**: both the webpage's consolidated
"Recent Wallet Top-Ups" table and Telegram's "2 most recent" selection
were sorting `createdAt` (format `"13/07/26, 8:42 pm"`, DD/MM/YY h:mm a)
as a **plain string**, not a real timestamp. This breaks two ways: across
month boundaries (`"02/07/26"` sorts before `"30/06/26"` alphabetically,
even though June 30 is earlier) and within the same day (`"8:40 am"` sorts
above `"8:02 pm"` since string comparison ignores am/pm entirely). Fixed
with a real `parseWalletTimestamp()` parser in both
`docs/index.html` and `scripts/telegram-alert.js` (duplicated
intentionally, same reason the commission formulas are duplicated between
the Node scripts and the browser script — no shared module between them —
**keep both in sync if this ever changes**).

**Wallet-log timestamps were also wrong by 5.5 hours on CI, fixed
2026-07-15**: separate bug from the sort issue above. Paynix's dashboard
renders the "Created" column **client-side**, using the scraping
browser's local timezone. None of the Playwright `browser.newContext()`
calls in this project set an explicit `timezoneId`, so the rendered time
follows the host OS's timezone — correct when run locally (this dev
machine is IST), but silently shifted 5.5 hours earlier than real IST
whenever the scrape ran on a GitHub Actions runner (UTC by default).
Confirmed by comparing a DOM-scraped Sunshine Global entry against
Paynix's own raw API (`GET .../wallet/load-requests`, discovered while
investigating — same technique as the payouts API used elsewhere): the
DOM text matched the API's UTC `created_at` + 5:30 exactly when scraped
locally, which is the tell that it's a client-rendering timezone issue,
not a data-content bug. **Fixed by pinning `timezoneId: 'Asia/Kolkata'`
on every browser context** across `download-paynix.js`,
`download-paynix-merchant-wallets.js`, `download-pixlerpay-merchant.js`,
and `download-report.js` (the last one preventively — no confirmed bug
there, but same risk pattern). Wallet logs aren't part of the
incremental-merge system (each run just overwrites the top-5 per
merchant, no dedupe/history) so the fix takes effect immediately on the
next run, no backfill needed. `download-paynix-merchant-reports.js` was
NOT at risk — it reads `created_at` straight from the API as a raw ISO
string, never DOM-rendered, so it was never timezone-dependent.

No-ops cleanly (logs and exits 0) if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
aren't set — safe to run even before the bot exists.

**Caution for next session**: dynamically `import()`-ing
`telegram-alert.js` (or any of these scripts) to inspect it **executes its
top-level `run()` call for real**, including sending live Telegram
messages if credentials are set in `.env` — this actually happened once
while testing (2026-07-14, 3 unintended real messages sent). To test
message content safely, read the file and reason about the code, or
extract the pure `build*Message()` functions into a separate
importable module — don't `import()` the script itself.

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

1. **Scheduled automation cadence is unreliable — see the diagnosis in the Automation section above.** GitHub's `schedule` trigger delivers roughly 10-13% of the configured 15/30-min frequency; real cadence is ~hourly, sometimes 3+ hours overnight. Fix chosen (external cron via cron-job.org → `workflow_dispatch` API) but not yet implemented as of this writing — needs a fine-grained PAT created and two cron-job.org jobs configured (steps documented above).
2. **"Refresh" buttons on the dashboard only re-fetch the latest Drive snapshot** — they cannot trigger a brand-new live scrape synchronously on click, because GitHub Pages is a static site with no backend, and GitHub Actions workflows aren't instant/synchronous from a browser click. Genuine "click → scrape happens right now, wait, see fresh data" still needs a real server (VM) or a more involved workflow-dispatch + polling setup.
   - **Status:** not built. A VM remains the option if true instant on-demand refresh is ever needed.
3. **N V CONNECT ACROSS PRIVATE LIMITED (PixlerPay)** — automation fails; its "DT and Payout" combined solution type has a different portal layout (the "Payouts Transaction" nav link isn't found, times out after 30s). Not fixed. Workaround: `data/manual-transactions.json` has one manual entry (₹50,00,000 on 2026-07-02 → ₹10,000 commission at 0.20% margin) added by the user; add more entries there in the same shape as needed.
4. **3 PixlerPay clients showed zero transactions** in an earlier scrape (Elleaura, FINFLEX, WESURE cybertech/infra/innovations) — flagged as worth a manual sanity check since they're marked Active/Onboarding in the rate sheet, but not investigated further.
5. **Paynix's aggregate "Wallet Change" column is still inferred from balance deltas** between runs (current − previous), not a real ledger — this is separate from (and coarser than) the per-merchant "Load Requests" log, which IS a real log for the 9 merchants with credentials.
6. **One pre-existing scraping quirk, not yet fixed**: at least one failed payout's `reason` field scraped as the literal string `"FAILED"` instead of a real gateway message — a minor regex miss in `scrapeFailedPayouts()`'s reason-extraction pattern. Low priority, cosmetic (doesn't affect the commission math), noticed while testing Telegram alert formatting.
7. **Only 9 of 13 Paynix merchants have merchant-portal logins** (`data/paynix-merchant-logins.json`, gitignored). Missing: APAS TECH POINT, PPAY SOLUTION, Global Books Trading, Define Enterprises. Their rows on the Paynix tab show no "Recent" wallet-log toggle since there's nothing to scrape. Add credentials in the same JSON shape (and update the `PAYNIX_MERCHANT_LOGINS` GitHub secret) to close the gap.
8. **Dashboard's stale-badge threshold (20 min) doesn't match real automation cadence** (~60-90+ min) — see the Automation section's note. Should be reconciled once item 1 is fixed and real cadence is known.
9. **One transient CI failure observed** (of ~20 runs so far): `wallet-alert.yml` run on 2026-07-11 23:35 UTC failed because the Paynix reseller login page timed out twice in a row (60s each, via the retry already built into `gotoWithRetry`). Self-healed on the next run — not a recurring pattern, just noted for awareness. If it becomes frequent, the retry timeout/count may need tuning.

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
│   ├── generate-commission-report.cjs  # formatted PixlerPay Excel report for any date range (npm run commission-report)
│   ├── download-paynix-merchant-reports.js  # Paynix: 9 merchant portals, recent-window payout history (margin+AK calc)
│   ├── calculate-paynix-commission.js  # Paynix: margin + AK commission calc, merge/prune
│   ├── fetch-reseller-ledger-range.mjs  # one-off: reseller wallet ledger (COMMISSION entries) for an explicit date range
│   ├── fetch-merchant-payouts-range.mjs  # one-off: full merchant payout history for an explicit date range
│   ├── generate-paynix-crosscheck.cjs  # one-off: builds Paynix_Commission_CrossCheck_<range>.xlsx (ours vs Paynix-credited)
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
