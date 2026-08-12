import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWalletTimestamp } from '../scripts/lib/wallet-timestamp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

test('parseWalletTimestamp: parses DD/MM/YY, h:mm am/pm', () => {
  const t1 = parseWalletTimestamp('13/07/26, 8:42 pm');
  const t2 = parseWalletTimestamp('02/07/26, 9:00 am');
  // 13 July is after 2 July.
  assert.ok(t1 > t2);
});

test('parseWalletTimestamp: sorts correctly across a month boundary', () => {
  // The exact bug this function exists to fix — a plain string sort puts
  // "02/07/26" before "30/06/26" alphabetically, even though June 30 is
  // earlier than July 2.
  const june30 = parseWalletTimestamp('30/06/26, 11:00 pm');
  const july2 = parseWalletTimestamp('02/07/26, 1:00 am');
  assert.ok(june30 < july2);
});

test('parseWalletTimestamp: noon and midnight edge cases', () => {
  const noon = parseWalletTimestamp('01/01/26, 12:00 pm');
  const midnight = parseWalletTimestamp('01/01/26, 12:00 am');
  const elevenAm = parseWalletTimestamp('01/01/26, 11:00 am');
  const onePm = parseWalletTimestamp('01/01/26, 1:00 pm');
  assert.ok(midnight < elevenAm); // 12am is start of day, before 11am
  assert.ok(elevenAm < noon); // 11am before 12pm
  assert.ok(noon < onePm); // 12pm before 1pm
});

test('parseWalletTimestamp: unparseable input returns 0, not a crash', () => {
  assert.equal(parseWalletTimestamp(''), 0);
  assert.equal(parseWalletTimestamp(null), 0);
  assert.equal(parseWalletTimestamp(undefined), 0);
  assert.equal(parseWalletTimestamp('garbage'), 0);
});

// Drift guard: this exact function is deliberately duplicated inline in
// docs/index.html and docs/paynix-atmoon.html (no build step in this
// project, so the browser copies can't import scripts/lib/wallet-timestamp.js
// directly). Extract each HTML file's copy and confirm it produces
// identical output to the canonical module for the same set of inputs —
// if someone edits one copy and forgets the others, this test fails
// instead of the drift going unnoticed until a live "most recent 10
// entries" display quietly shows the wrong order.
function extractInlineFunction(html, fnName) {
  const marker = `function ${fnName}(`;
  const start = html.indexOf(marker);
  assert.ok(start !== -1, `${fnName} not found in HTML source — was it renamed or removed?`);
  // Walk forward from the opening brace to find the matching closing one.
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = html.slice(braceStart, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`return function ${fnName}(s) ${body}`)();
}

const SAMPLE_INPUTS = [
  '13/07/26, 8:42 pm',
  '02/07/26, 9:00 am',
  '30/06/26, 11:00 pm',
  '01/01/26, 12:00 pm',
  '01/01/26, 12:00 am',
  '',
  'garbage',
];

for (const htmlFile of ['docs/index.html', 'docs/paynix-atmoon.html']) {
  test(`parseWalletTimestamp in ${htmlFile} matches the canonical module`, () => {
    const html = fs.readFileSync(path.join(ROOT, htmlFile), 'utf-8');
    const inlineFn = extractInlineFunction(html, 'parseWalletTimestamp');
    for (const input of SAMPLE_INPUTS) {
      assert.equal(
        inlineFn(input),
        parseWalletTimestamp(input),
        `Mismatch for input ${JSON.stringify(input)} — ${htmlFile}'s copy has drifted from scripts/lib/wallet-timestamp.js`
      );
    }
  });
}
