// Canonical parser for Paynix's wallet-log "Created" timestamp format,
// e.g. "13/07/26, 8:42 pm" (DD/MM/YY, h:mm am/pm). A plain string sort
// breaks across month boundaries (e.g. "02/07/26" < "30/06/26"
// alphabetically, even though June 30 is earlier than July 2) — this bit
// the webpage's consolidated wallet-log table (fixed 2026-07-14) and
// would silently show the wrong "N most recent" entries anywhere else
// that trusted scrape order instead of this.
//
// This exact function is ALSO duplicated (deliberately — no build step in
// this project, docs/index.html is a static file with no import
// mechanism) inline in docs/index.html. There is no way to make the
// browser copy import this module without adding a bundler, which is a
// bigger change than this warrants. Instead, test/wallet-timestamp.test.js
// extracts the docs/index.html copy via regex and asserts it produces
// identical output to this one for a shared set of sample inputs — so a
// future edit to just one copy fails CI instead of silently drifting.
// If you change the parsing logic here, update docs/index.html's copy
// (search for "function parseWalletTimestamp") in the same commit.
export function parseWalletTimestamp(s) {
  const m = s && String(s).match(/^(\d{2})\/(\d{2})\/(\d{2}),\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return 0;
  let [, dd, mo, yy, hh, mm, ap] = m;
  hh = parseInt(hh, 10);
  if (/pm/i.test(ap) && hh !== 12) hh += 12;
  if (/am/i.test(ap) && hh === 12) hh = 0;
  return new Date(2000 + parseInt(yy, 10), parseInt(mo, 10) - 1, parseInt(dd, 10), hh, parseInt(mm, 10)).getTime();
}
