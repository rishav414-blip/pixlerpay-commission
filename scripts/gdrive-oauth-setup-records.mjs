// Separate one-time OAuth consent flow for the Paynix reconciliation
// "records" sheet workflow (sync-sumeet-records.mjs). Uses the same OAuth
// client as the main pipeline (data/gdrive-oauth-client.json) but writes to
// a SEPARATE token file (data/gdrive-oauth-token-records.json) so signing in
// as a different Google account here does not overwrite/break the main
// pipeline's rishav414@gmail.com token used by upload-to-drive.js.
import fs from 'node:fs';
import http from 'node:http';
import { exec } from 'node:child_process';
import { google } from 'googleapis';

const CLIENT_FILE = './data/gdrive-oauth-client.json';
const TOKEN_FILE = './data/gdrive-oauth-token-records.json';
const PORT = 53683; // different port than gdrive-oauth-setup.js's 53682
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

if (!fs.existsSync(CLIENT_FILE)) {
  console.error(`Missing ${CLIENT_FILE}.`);
  process.exit(1);
}

const { installed } = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf-8'));
const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive'],
});

console.log('Opening browser for Google sign-in / consent...');
console.log('IMPORTANT: sign in as rinariapexservices@gmail.com (not rishav414@gmail.com) when prompted.');
console.log('If it does not open automatically, visit this URL:\n');
console.log(authUrl, '\n');

exec(`start "" "${authUrl}"`);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Authorization failed: ${error}. You can close this window.`);
    console.error('Authorization failed:', error);
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Authorized. You can close this window and return to the terminal.');
    console.log(`\nSaved refresh token to ${TOKEN_FILE}`);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Token exchange failed. Check the terminal.');
    console.error('Token exchange failed:', err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT, () => {
  console.log(`Waiting for you to approve access in the browser (listening on localhost:${PORT})...`);
});
