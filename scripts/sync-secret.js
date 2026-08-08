// Wraps `gh secret set` for the credential files health-check.js tracks
// drift on (data/accounts.json, data/paynix-merchant-logins.json), and
// records a hash + timestamp to data/credential-sync-state.json (git-
// tracked — hashes only, never the credential content itself) right after
// a successful push. This is what lets health-check.js notice "this local
// file changed since it was last mirrored to the GitHub secret" instead
// of that going unnoticed until CI's login step starts failing for a
// merchant added days ago (exactly what happened 2026-08-08 with the 5
// new Paynix merchants — the local file had them, the secret didn't, and
// nothing flagged the mismatch until commission data was already missing).
//
// Usage: node scripts/sync-secret.js <ACCOUNTS_JSON|PAYNIX_MERCHANT_LOGINS>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPO = 'rishav414-blip/pixlerpay-commission';
const STATE_FILE = path.join('./data', 'credential-sync-state.json');
const KNOWN = {
  ACCOUNTS_JSON: './data/accounts.json',
  PAYNIX_MERCHANT_LOGINS: './data/paynix-merchant-logins.json',
};

const name = process.argv[2];
if (!name || !KNOWN[name]) {
  console.error(`Usage: node scripts/sync-secret.js <${Object.keys(KNOWN).join('|')}>`);
  process.exit(1);
}

const filePath = KNOWN[name];
if (!fs.existsSync(filePath)) {
  console.error(`${filePath} not found.`);
  process.exit(1);
}

const content = fs.readFileSync(filePath);
const hash = crypto.createHash('sha256').update(content).digest('hex');

console.log(`Setting GitHub secret ${name} from ${filePath}...`);
execFileSync('gh', ['secret', 'set', name, '--repo', REPO], { input: content, stdio: ['pipe', 'inherit', 'inherit'] });

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) : {};
state[name] = { hash, syncedAt: new Date().toISOString() };
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
console.log(`Recorded sync state for ${name} in ${STATE_FILE}.`);
