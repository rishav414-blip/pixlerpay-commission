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

  await page.waitForTimeout(3000);
}
