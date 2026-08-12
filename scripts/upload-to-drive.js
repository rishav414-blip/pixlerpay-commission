import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';

const {
  GOOGLE_DRIVE_FOLDER_ID,
  GOOGLE_DRIVE_RESULTS_FILE_ID, // known file ID to update in place (avoids creating a duplicate)
  GOOGLE_DRIVE_PAYNIX_FILE_ID,
  GOOGLE_DRIVE_PIXLERPAY_MERCHANT_FILE_ID,
  GOOGLE_DRIVE_PAYNIX_COMMISSION_FILE_ID,
  GOOGLE_DRIVE_PAYNIX_WALLETLOG_FILE_ID,
  GOOGLE_DRIVE_PAYNIX_ATMOON_COMMISSION_FILE_ID,
  GOOGLE_DRIVE_PAYNIX_ATMOON_FILE_ID,
  GOOGLE_DRIVE_PAYNIX_ATMOON_WALLETLOG_FILE_ID,
} = process.env;

const OAUTH_CLIENT_FILE = './data/gdrive-oauth-client.json';
const OAUTH_TOKEN_FILE = './data/gdrive-oauth-token.json';
const RESULTS_FILE = path.join('./website', 'commission-results.json');
const PAYNIX_RESULTS_FILE = path.join('./website', 'paynix-results.json');
const PIXLERPAY_MERCHANT_RESULTS_FILE = path.join('./website', 'pixlerpay-merchant-results.json');
const PAYNIX_COMMISSION_RESULTS_FILE = path.join('./website', 'paynix-commission-results.json');
const PAYNIX_WALLETLOG_RESULTS_FILE = path.join('./website', 'paynix-wallet-log-results.json');
const PAYNIX_ATMOON_COMMISSION_RESULTS_FILE = path.join('./website', 'paynix-atmoon-commission-results.json');
const PAYNIX_ATMOON_RESULTS_FILE = path.join('./website', 'paynix-atmoon-results.json');
const PAYNIX_ATMOON_WALLETLOG_RESULTS_FILE = path.join('./website', 'paynix-atmoon-wallet-log-results.json');

// Single source of truth for "which files get uploaded, to which Drive
// file ID, under which name" — was 8 near-identical `if (fs.existsSync(X))
// { await uploadFile(X, name, mime, envId); }` blocks in run() below, one
// per file, that had drifted out of sync with this array (ALL_FILES used
// to only feed the "nothing to upload" guard, not actually drive the
// uploads). Collapsed 2026-08-12 so adding the next file is one array
// entry, not a copy-pasted block.
const FILE_SPECS = [
  { path: RESULTS_FILE, driveName: 'commission-results.json', envId: GOOGLE_DRIVE_RESULTS_FILE_ID },
  { path: PAYNIX_RESULTS_FILE, driveName: 'paynix-results.json', envId: GOOGLE_DRIVE_PAYNIX_FILE_ID },
  { path: PIXLERPAY_MERCHANT_RESULTS_FILE, driveName: 'pixlerpay-merchant-results.json', envId: GOOGLE_DRIVE_PIXLERPAY_MERCHANT_FILE_ID },
  { path: PAYNIX_COMMISSION_RESULTS_FILE, driveName: 'paynix-commission-results.json', envId: GOOGLE_DRIVE_PAYNIX_COMMISSION_FILE_ID },
  { path: PAYNIX_WALLETLOG_RESULTS_FILE, driveName: 'paynix-wallet-log-results.json', envId: GOOGLE_DRIVE_PAYNIX_WALLETLOG_FILE_ID },
  { path: PAYNIX_ATMOON_COMMISSION_RESULTS_FILE, driveName: 'paynix-atmoon-commission-results.json', envId: GOOGLE_DRIVE_PAYNIX_ATMOON_COMMISSION_FILE_ID },
  { path: PAYNIX_ATMOON_RESULTS_FILE, driveName: 'paynix-atmoon-results.json', envId: GOOGLE_DRIVE_PAYNIX_ATMOON_FILE_ID },
  { path: PAYNIX_ATMOON_WALLETLOG_RESULTS_FILE, driveName: 'paynix-atmoon-wallet-log-results.json', envId: GOOGLE_DRIVE_PAYNIX_ATMOON_WALLETLOG_FILE_ID },
];
if (!FILE_SPECS.some((f) => fs.existsSync(f.path))) {
  console.error(`Missing all of ${FILE_SPECS.map((f) => f.path).join(', ')}. Run the relevant download/calculate script(s) first.`);
  process.exit(1);
}

if (!fs.existsSync(OAUTH_CLIENT_FILE) || !fs.existsSync(OAUTH_TOKEN_FILE)) {
  console.error('Google Drive OAuth is not set up yet.');
  console.error('Run: npm run gdrive-oauth-setup');
  console.error('See README.md "Google Drive sync" for the one-time Cloud Console step first.');
  process.exit(1);
}

if (!GOOGLE_DRIVE_FOLDER_ID) {
  console.error('Missing GOOGLE_DRIVE_FOLDER_ID in .env.');
  process.exit(1);
}

const { installed } = JSON.parse(fs.readFileSync(OAUTH_CLIENT_FILE, 'utf-8'));
const tokens = JSON.parse(fs.readFileSync(OAUTH_TOKEN_FILE, 'utf-8'));

const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret);
oauth2Client.setCredentials(tokens);
oauth2Client.on('tokens', (newTokens) => {
  // Refresh tokens don't rotate on every use, but persist if Google issues a new one.
  const merged = { ...tokens, ...newTokens };
  fs.writeFileSync(OAUTH_TOKEN_FILE, JSON.stringify(merged, null, 2));
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

async function findExistingFile(name, knownFileId) {
  if (knownFileId) {
    try {
      const res = await drive.files.get({ fileId: knownFileId, fields: 'id, name' });
      return res.data;
    } catch {
      // Fall through to name-based lookup if the known ID no longer resolves.
    }
  }
  const res = await drive.files.list({
    q: `name = '${name}' and '${GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id, name)',
  });
  return res.data.files?.[0] || null;
}

async function uploadFile(localPath, driveName, mimeType, knownFileId) {
  const media = { mimeType, body: fs.createReadStream(localPath) };
  const existing = await findExistingFile(driveName, knownFileId);

  if (existing) {
    await drive.files.update({ fileId: existing.id, media });
    console.log(`Updated existing Drive file: ${driveName} (${existing.id})`);
    return existing.id;
  }

  const res = await drive.files.create({
    requestBody: { name: driveName, parents: [GOOGLE_DRIVE_FOLDER_ID] },
    media,
    fields: 'id',
  });
  const fileId = res.data.id;
  console.log(`Created new Drive file: ${driveName} (${fileId})`);

  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  console.log(`Set "anyone with link can view" on ${driveName}`);
  console.log('NOTE: this is a NEW file ID — update GOOGLE_DRIVE_RESULTS_FILE_ID in .env and DRIVE_FILE_ID in docs/index.html.');

  return fileId;
}

async function run() {
  let uploaded = 0;
  let skipped = 0;
  const failures = [];

  for (const spec of FILE_SPECS) {
    if (!fs.existsSync(spec.path)) {
      skipped++;
      continue;
    }
    // Isolated per-file, added 2026-08-12 — previously a single failed
    // upload (a transient Drive API error, say) threw straight out of the
    // sequential await chain and aborted every file after it in the list,
    // silently skipping uploads that had nothing wrong with them. Now one
    // bad file is recorded and the rest still get attempted.
    try {
      const fileId = await uploadFile(spec.path, spec.driveName, 'application/json', spec.envId);
      console.log(`${spec.driveName} Drive file ID:`, fileId);
      uploaded++;
    } catch (err) {
      console.error(`FAILED to upload ${spec.driveName}: ${err.message}`);
      failures.push(spec.driveName);
    }
  }

  console.log(`\nDone. ${uploaded} uploaded, ${skipped} not present locally (skipped)${failures.length ? `, ${failures.length} FAILED: ${failures.join(', ')}` : ''}.`);
  // Non-zero exit if anything failed, but only after every other file was
  // still attempted above — callers with continue-on-error already tolerate
  // this; the point is the failure is visible instead of silently eaten.
  if (failures.length) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Upload failed:', err.message);
  process.exit(1);
});
