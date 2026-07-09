import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const DATA_DIR = './data';
const CSV_PATH = process.argv[2] || path.join(DATA_DIR, 'chrome-passwords.csv');
const RATES_FILE = path.join(DATA_DIR, 'commission-rates.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'accounts.json');

if (!fs.existsSync(CSV_PATH)) {
  console.error(`CSV not found at ${CSV_PATH}.`);
  console.error('Export it from chrome://password-manager/settings -> "Export passwords", then pass the path:');
  console.error('  node scripts/import-accounts.js path/to/chrome-passwords.csv');
  process.exit(1);
}

const raw = fs.readFileSync(CSV_PATH, 'utf-8');
const rows = parse(raw, { columns: true, skip_empty_lines: true });

const pixlerRows = rows.filter((r) => {
  const url = (r.url || r.origin_url || '').toLowerCase();
  return url.includes('pixlerpay.com');
});

if (pixlerRows.length === 0) {
  console.error('No pixlerpay.com entries found in the exported CSV.');
  process.exit(1);
}

const rates = JSON.parse(fs.readFileSync(RATES_FILE, 'utf-8'));
const clientNames = rates.map((r) => r.clientName);

const STOPWORDS = new Set(['private', 'limited', 'pvt', 'ltd', 'technologies', 'technology', 'techno', 'innovations', 'innovative', 'solutions', 'solution', 'services', 'and', 'the', 'india', 'cybertech', 'infra', 'supply', 'point', 'tech']);

function significantWords(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

// Only the username's local-part (before @) is used for matching — the CSV's
// "name" column is just the generic site label (e.g. "pixlerpay.com") for
// every row and carries no per-account signal.
function guessClientName(username) {
  const localPart = (username || '').split('@')[0];
  const candWords = significantWords(localPart);
  if (candWords.length === 0) return `UNMATCHED: ${username}`;

  let best = null;
  let bestScore = 0;
  for (const cn of clientNames) {
    const cnWords = significantWords(cn);
    const score = cnWords.filter((w) => candWords.some((cw) => cw.includes(w) || w.includes(cw))).length;
    if (score > bestScore) {
      bestScore = score;
      best = cn;
    }
  }
  return bestScore > 0 ? best : `UNMATCHED: ${username}`;
}

const accounts = pixlerRows.map((r) => ({
  name: guessClientName(r.username),
  username: r.username,
  password: r.password,
}));

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(accounts, null, 2));
console.log(`Imported ${accounts.length} PixlerPay account(s) into ${OUTPUT_FILE}`);
console.log('Review the "name" field on each entry — auto-matching to client names is best-effort.');
console.log('\nIMPORTANT: delete the exported CSV now, it is plaintext credentials:');
console.log(`  del "${CSV_PATH}"`);
