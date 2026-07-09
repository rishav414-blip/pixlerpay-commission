import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';

const {
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
  GOOGLE_DRIVE_FOLDER_ID,
} = process.env;

if (!GOOGLE_SERVICE_ACCOUNT_KEY_FILE || !GOOGLE_DRIVE_FOLDER_ID) {
  console.error('Missing GOOGLE_SERVICE_ACCOUNT_KEY_FILE and/or GOOGLE_DRIVE_FOLDER_ID in .env.');
  console.error('See README.md "Google Drive sync" section for one-time setup steps.');
  process.exit(1);
}

if (!fs.existsSync(GOOGLE_SERVICE_ACCOUNT_KEY_FILE)) {
  console.error(`Service account key file not found at: ${GOOGLE_SERVICE_ACCOUNT_KEY_FILE}`);
  process.exit(1);
}

const RESULTS_FILE = path.join('./website', 'commission-results.json');

if (!fs.existsSync(RESULTS_FILE)) {
  console.error(`Missing ${RESULTS_FILE}. Run "npm run calculate" first.`);
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/drive'],
});

const drive = google.drive({ version: 'v3', auth });

async function findExistingFile(name) {
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

  // Make it readable via link so the hosted dashboard can fetch it client-side.
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  console.log(`Set "anyone with link can view" on ${driveName}`);

  return fileId;
}

async function run() {
  const resultsFileId = await uploadFile(RESULTS_FILE, 'commission-results.json', 'application/json');
  console.log('\nDone. commission-results.json Drive file ID:', resultsFileId);
  console.log('Use this file ID + a Drive API key in the hosted dashboard to fetch live data.');
}

run().catch((err) => {
  console.error('Upload failed:', err.message);
  process.exit(1);
});
