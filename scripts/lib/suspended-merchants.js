import { fetchPreviousFromDrive } from './drive-fetch.js';

// Suspended Paynix merchant accounts can never log in successfully — this
// was initially misdiagnosed as an OTP rate-limit issue (the failure
// message is identical: "paynix_access_token never appeared in
// localStorage"), until cross-referencing the reseller snapshot's
// `status` field confirmed the real cause 2026-08-10. Retrying against a
// suspended account is pure waste: it can't ever succeed, and each
// attempt still risks tripping Paynix's real OTP rate limit for
// unrelated, actually-active accounts sharing the same login flow.
//
// Explicit instruction 2026-08-11: don't run any process or send any
// alert for suspended accounts at all — not even the backed-off retry /
// critical-failure-alert path added the same day for genuine (recoverable)
// login failures. Callers should filter these merchantIds out of their
// login list *before* attempting anything, not treat them as a failure.
//
// Source of truth is the live reseller snapshot (refreshed by
// refresh.yml's download-paynix.js), not a hardcoded list — which
// merchants are suspended changes over time. Falls back to an empty set
// (no filtering) if the snapshot can't be fetched, so a Drive hiccup
// doesn't silently make every merchant filterable.
export async function getSuspendedMerchantIds(paynixFileId, apiKey) {
  const data = await fetchPreviousFromDrive(paynixFileId, apiKey);
  const ids = new Set(
    (data?.merchants || [])
      .filter((m) => m.status === 'Suspended')
      .map((m) => m.merchantId)
  );
  return ids;
}
