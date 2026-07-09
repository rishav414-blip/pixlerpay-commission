import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';

const {
  GOOGLE_DRIVE_FOLDER_ID,
  GOOGLE_DRIVE_RESULTS_FILE_ID, // known file ID to update in place (avoids creating a duplicate)
} = process.env;

const OAUTH_CLIENT_FILE = './data/gdrive-oauth-client.json';
const OAUTH_TOKEN_FILE = './data/gdrive-oauth-token.json';
const RESULTS_FILE = path.join('./website', 'commission-results.json');

if (!fs.existsSync(RESULTS_FILE)) {
  console.error(`Missing ${RESULTS_FILE}. Run "npm run calculate" first.`);
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

async function findExistingFile(name) {
  if (GOOGLE_DRIVE_RESULTS_FILE_ID) {
    try {
      const res = await drive.files.get({ fileId: GOOGLE_DRIVE_RESULTS_FILE_ID, fields: 'id, name' });
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

async function uploadFile(localPath, driveName, mimeType) {
  const media = { mimeType, body: fs.createReadStream(localPath) };
  const existing = await findExistingFile(driveName);

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
  const resultsFileId = await uploadFile(RESULTS_FILE, 'commission-results.json', 'application/json');
  console.log('\nDone. commission-results.json Drive file ID:', resultsFileId);
}

run().catch((err) => {
  console.error('Upload failed:', err.message);
  process.exit(1);
});
