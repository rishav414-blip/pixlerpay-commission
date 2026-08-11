// Shared login helper, originally for merchant.paynix.co.in (used by
// download-paynix-merchant-reports.js, download-paynix-merchant-wallets.js,
// download-pixlerpay-merchant.js) — **also confirmed 2026-08-10 to apply to
// the reseller portal** (reseller.paynix.co.in, used by download-paynix.js).
// The health-check alerted that Paynix reseller data was 9h stale despite
// refresh.yml reporting "success" every run; the reseller login step has
// `continue-on-error: true`, which was masking a real failure. Root cause:
// Paynix added the exact same OTP step to the reseller login too, and
// download-paynix.js's login block had never been updated for it — so every
// reseller login silently failed post-login (redirected back to
// /auth/login), and scrapeFailedPayouts()'s "Payouts" tab click then timed
// out because it was never really on the transactions page. Fixed by
// switching download-paynix.js to this same helper.
//
// Added 2026-08-10: Paynix started requiring a 6-digit email OTP after
// email/password on this portal (input#otp, placeholder "6-digit code",
// button "Verify & Log in") — previously a plain single-step login. Every
// merchant/account's OTP is a fixed 123456 per the user (test/sandbox
// value, not a real per-run emailed code). Not every login necessarily
// prompts for it (a trusted device/session may skip it), so this waits
// briefly for the OTP field rather than assuming it's always present.
//
// Confirmed live 2026-08-10 for one merchant (Curiobyte) before repeated
// test logins triggered Paynix's own OTP rate limit ("Too many OTP
// requests. Please try again in 15 minutes.") — if logins still fail after
// this, check whether the rate limit is the cause (too many runs in a
// short window) rather than the OTP handling itself being wrong.
//
// **Bug found and fixed 2026-08-10, same day**: the first version of this
// helper just did a flat `waitForTimeout(3000)` after clicking "Verify &
// Log in" (or after the plain "Log in" click, if no OTP appeared), then
// assumed `localStorage.paynix_access_token` was ready. In the first live
// full-pipeline run after deploying this, 6 of 20 merchants failed with
// `UNAUTHORIZED: Invalid or expired token` from the payouts API — a race
// between the token actually being written to localStorage post-login and
// the fixed 3s guess, worse under CI network latency than in local
// testing. Fixed by polling for the token to actually appear (up to 15s)
// instead of guessing a fixed delay.
import fs from 'node:fs';
import path from 'node:path';

// Session-reuse wrapper, added 2026-08-11 after diagnosing why VYSHIKAX's
// wallet-top-up alerts had gone silently stale for days: wallet-alert.yml
// dispatches every 5 minutes and re-logs-in fresh (thus re-requesting a new
// OTP) for all 20 merchants on every single run. Paynix's own OTP request
// has a per-account cooldown ("Too many OTP requests. Please try again in
// 15 minutes.", see completePaynixLogin below) — any account that actually
// requires the OTP step (not all do; some skip it on what's presumably a
// recognized/trusted session) was structurally guaranteed to keep tripping
// that cooldown under a 5-minute cadence, permanently failing to log in.
// Manual one-off tests looked fine because they didn't hit the rate limit.
//
// Fix: persist the logged-in session (cookies + localStorage, i.e. the
// access token) to disk via Playwright's storageState, and reuse it on the
// next run instead of logging in again — only fall back to a fresh
// login+OTP when the restored session turns out to be actually expired
// (detected by landing back on /auth/login after navigating to the
// dashboard with the restored state). This cuts login attempts — and OTP
// requests — down to roughly once per session lifetime instead of once
// per 5-minute run.
//
// CI persistence: the caller's workflow is responsible for caching the
// sessionFile's directory (actions/cache) across runs, since each run is a
// fresh checkout with no memory of the last one otherwise.
export async function getAuthenticatedContext(browser, {
  sessionFile,
  dashboardUrl,
  contextOptions = {},
  performLogin, // async (page) => void — must leave page authenticated on return
}) {
  if (sessionFile && fs.existsSync(sessionFile)) {
    try {
      const context = await browser.newContext({ storageState: sessionFile, ...contextOptions });
      const page = await context.newPage();
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
      if (!page.url().includes('/auth/login')) {
        return { context, page, reused: true };
      }
      // Restored session is expired/invalid — fall through to a fresh login.
      await context.close();
    } catch {
      // Corrupt/unreadable session file — ignore and do a fresh login below.
    }
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  try {
    await performLogin(page);
  } catch (err) {
    // Don't leak the context if login fails — the caller's own try/catch
    // handles the error itself (e.g. falling back to a preserved baseline),
    // but it never gets a context reference to close in that case.
    await context.close();
    throw err;
  }
  if (sessionFile) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    await context.storageState({ path: sessionFile });
  }
  return { context, page, reused: false };
}

export async function loginPaynixMerchant(page, loginUrl, username, password) {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await completePaynixLogin(page, username, password);
}

// Split out so callers that need their own page.goto (e.g.
// download-paynix.js's gotoWithRetry, for network-flakiness resilience) can
// still reuse the fill/OTP/token-wait logic without a duplicate goto.
export async function completePaynixLogin(page, username, password) {
  await page.getByRole('textbox', { name: 'Email address' }).fill(username);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();

  const otpField = page.locator('#otp');
  const otpAppeared = await otpField
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (otpAppeared) {
    await otpField.fill('123456');
    await page.getByRole('button', { name: /verify/i }).click();
  }

  const tokenReady = await page
    .waitForFunction(() => !!localStorage.getItem('paynix_access_token'), { timeout: 15000 })
    .then(() => true)
    .catch(() => false);

  if (!tokenReady) {
    // Surface *why* — "suspended", "Invalid credentials", "Too many OTP
    // requests", or something new — directly in the thrown error instead of
    // making the next person re-run a manual debug script to find out.
    // Added 2026-08-10 after VYSHIKAX/WILDBADGER (confirmed working in
    // isolated manual tests minutes earlier) failed again in the very next
    // full-fleet CI run — almost certainly because those manual tests had
    // just consumed their OTP quota and tripped Paynix's per-account rate
    // limit, but that was a guess at the time; this makes it provable.
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '(could not read page text)');
    throw new Error(`paynix_access_token never appeared in localStorage after login. Page text: ${JSON.stringify(pageText)}`);
  }

  // Small settle margin — the token existing doesn't guarantee the app has
  // finished its own post-login redirect/state setup.
  await page.waitForTimeout(500);
}
