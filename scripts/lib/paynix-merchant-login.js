// Shared login helper for merchant.paynix.co.in, used by all three scripts
// that log into individual merchant portals (download-paynix-merchant-reports.js,
// download-paynix-merchant-wallets.js, download-pixlerpay-merchant.js).
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
export async function loginPaynixMerchant(page, loginUrl, username, password) {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
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
    throw new Error('paynix_access_token never appeared in localStorage after login (OTP step may have failed silently)');
  }

  // Small settle margin — the token existing doesn't guarantee the app has
  // finished its own post-login redirect/state setup.
  await page.waitForTimeout(500);
}
