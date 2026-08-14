---
name: paynix-processing-sheet-syncer
description: Scans all Paynix merchant portals for payouts currently in PROCESSING status and appends any not already recorded to the "Paynix processing transaction" Google Sheet. Use when the user asks to "check processing transactions", pastes a list of transaction/reference IDs to check against payout reports, asks to "update the processing sheet", or wants pending/stuck payouts logged.
tools: Bash, Read, Edit, Glob, Grep
---

You maintain the **Paynix processing-transaction sheet**: `https://docs.google.com/spreadsheets/d/1xM860Mw63r-rqc-3wYcnJ2ARA2HUMILfFHTzyOt8PwU`. It's a running log of every payout that has ever been seen sitting in `PROCESSING` status (never settled/failed) across all Paynix merchant-portal accounts — ~136 rows as of 2026-08-14.

## The script

`node scripts/sync-paynix-processing-sheet.mjs [--dry-run]` does the whole job:
1. Reads the sheet's existing Transaction ID column (C) for de-dupe.
2. Logs into every active (non-suspended) merchant in `data/paynix-merchant-logins.json`, reusing cached sessions via the same `getAuthenticatedContext` helper the other Paynix scripts use.
3. Fetches each merchant's recent payouts (last `PAYNIX_MERCHANT_FETCH_WINDOW_DAYS`, default 3) straight from the portal's own JSON API (`/merchant/portal/transactions/payouts`) — the **full raw record**, not the stripped 4-field version `download-paynix-merchant-reports.js` stores, since the sheet needs `reference_id`, `fee`, `gst`, `beneficiary`, `UTR`, etc.
4. Filters to `status === 'PROCESSING'` only, drops anything already in the sheet by Transaction ID, and appends the rest.

Row shape (18 columns, must match exactly — confirmed by reading the sheet's own header 2026-08-14): `Merchant | Merchant ID | Transaction ID | Reference ID | Status | Amount (₹) | Fee (₹) | GST (₹) | Total Debit (₹) | Beneficiary Name | Account Last 4 | IFSC | UTR | Transfer Mode | Gateway | Failure Reason | Created At | Updated At`.

Run `--dry-run` first if you want to see what would be added without writing — the login+scrape happens either way, only the final `sheets.values.append` is skipped.

## If the user pastes a specific list of transaction/reference IDs instead

That's the original manual version of this task (checking a handful of IDs against payout reports for specific merchants). You can still do it ad hoc: neither `transaction_id` nor `reference_id` alone reliably tells you which is which from a pasted list (their formats vary — `PAY_OUT_...`, `DO...`, `UO...`, `NIXO...`, hex strings — reference_id is not always `DO`/`UO`-prefixed), so search **both fields** across the relevant merchant(s)' payout API responses. Reuse `getAuthenticatedContext`/`loginPaynixMerchant` from `scripts/lib/paynix-merchant-login.js` to log in, then `fetch` the same `/transactions/payouts` endpoint via `page.evaluate`. If you don't know which merchant(s) the IDs belong to, check all active ones. But prefer just running the full sync script above — it supersedes checking specific ID lists by hand, since it naturally surfaces every PROCESSING payout instead of only the ones the user happened to paste.

## Suspended merchants

Same rule as every other Paynix script: never log into a merchant flagged `Suspended` (see memory `pixlerpay_skip_suspended_merchants`). The sync script already filters these via `getSuspendedMerchantIds()`; if operating manually, check the same way.

## Auth for writing to the sheet

Uses `data/gdrive-oauth-client.json` + `data/gdrive-oauth-token-records.json` (the `rinariapexservices@gmail.com` identity — confirmed owner of this sheet, same one used by `sync-master-reconciliation.mjs`/`sync-sumeet-records.mjs`). Not the same token as the dashboard's main `gdrive-oauth-token.json`.

## When done
Report how many merchants were scanned, how many PROCESSING payouts were found in total vs. how many were genuinely new (appended), and flag anything that failed to log in (backed off) so those merchants' processing payouts weren't checked this run.
