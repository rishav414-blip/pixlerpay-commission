import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSuccessful,
  parseToISODate,
  resolveRateForDate,
  calcMarginCommission,
  calcAkCommission,
  calcAnsCommission,
} from '../scripts/calculate-paynix-commission.js';

test('isSuccessful', () => {
  assert.equal(isSuccessful('SUCCESS'), true);
  assert.equal(isSuccessful('success'), true);
  assert.equal(isSuccessful('  Success  '), true);
  assert.equal(isSuccessful('FAILED'), false);
  assert.equal(isSuccessful('PROCESSING'), false);
  assert.equal(isSuccessful(null), false);
  assert.equal(isSuccessful(undefined), false);
  assert.equal(isSuccessful(''), false);
});

test('parseToISODate: D/M/YYYY format (Paynix merchant export)', () => {
  assert.equal(parseToISODate('9/7/2026, 12:37:47 pm'), '2026-07-09');
  assert.equal(parseToISODate('29/12/2025, 11:59:00 pm'), '2025-12-29');
  assert.equal(parseToISODate(''), null);
  assert.equal(parseToISODate(null), null);
});

test('resolveRateForDate: no rateHistory returns the rate unchanged', () => {
  const rate = { onboardedPct: 1, resellerPct: 0.7 };
  assert.deepEqual(resolveRateForDate(rate, '2026-08-01'), rate);
});

test('resolveRateForDate: picks the latest applicable entry on/before the transaction date', () => {
  // Mirrors RASHEEYA's real rate history (see data/paynix-commission-rates.json)
  const rate = {
    onboardedPct: 0.9,
    resellerPct: 0.7,
    rateHistory: [
      { effectiveFrom: null, onboardedPct: 1, onboardedFlatBelow1000: 11 },
      { effectiveFrom: '2026-07-17', onboardedPct: 1.1, onboardedFlatBelow1000: 12 },
    ],
  };
  // Before the rate change: undated entry applies.
  assert.equal(resolveRateForDate(rate, '2026-07-10').onboardedPct, 1);
  // On/after the effective date: the newer entry applies.
  assert.equal(resolveRateForDate(rate, '2026-07-17').onboardedPct, 1.1);
  assert.equal(resolveRateForDate(rate, '2026-08-01').onboardedPct, 1.1);
});

test('resolveRateForDate: no isoDate falls back to the latest entry', () => {
  const rate = {
    rateHistory: [
      { effectiveFrom: null, onboardedPct: 1 },
      { effectiveFrom: '2026-07-17', onboardedPct: 1.1 },
    ],
  };
  assert.equal(resolveRateForDate(rate, null).onboardedPct, 1.1);
});

test('calcMarginCommission: flat rate at/below Rs1000', () => {
  const rate = { onboardedFlatBelow1000: 11, resellerFlatBelow1000: 10, onboardedPct: 0.9, resellerPct: 0.7 };
  assert.equal(calcMarginCommission(1000, rate), 1);
  assert.equal(calcMarginCommission(500, rate), 1);
  assert.equal(calcMarginCommission(1, rate), 1);
});

test('calcMarginCommission: percentage-based above Rs1000', () => {
  const rate = { onboardedFlatBelow1000: 11, resellerFlatBelow1000: 10, onboardedPct: 0.9, resellerPct: 0.7 };
  // (10000 * (0.9 - 0.7)) / 100 = 20 (approximate: floating-point 0.9-0.7 isn't exact)
  assert.ok(Math.abs(calcMarginCommission(10000, rate) - 20) < 1e-9);
});

test('calcMarginCommission: falls back to percentage math when flat fields are missing', () => {
  const rate = { onboardedFlatBelow1000: null, resellerFlatBelow1000: null, onboardedPct: 1, resellerPct: 0.7 };
  // (500 * (1 - 0.7)) / 100 = 1.5, even though amount <= 1000
  assert.ok(Math.abs(calcMarginCommission(500, rate) - 1.5) < 1e-9);
});

test('calcAkCommission: zero at/below Rs1000 regardless of akPct', () => {
  assert.equal(calcAkCommission(1000, { akPct: 0.1 }), 0);
  assert.equal(calcAkCommission(500, { akPct: 0.1 }), 0);
});

test('calcAkCommission: zero when akPct is null (no AK for this client)', () => {
  assert.equal(calcAkCommission(5000, { akPct: null }), 0);
});

test('calcAkCommission: percentage above Rs1000', () => {
  assert.equal(calcAkCommission(10000, { akPct: 0.1 }), 10);
});

test('calcAnsCommission: zero when ansPct is null (no Ansh part for this client)', () => {
  assert.equal(calcAnsCommission(5000, { ansPct: null }), 0);
});

test('calcAnsCommission: flat rate at/below Rs1000 (VIKZONE-style)', () => {
  const rate = { ansPct: 0.6, ansFlatBelow1000: 2 };
  assert.equal(calcAnsCommission(1000, rate), 2);
  assert.equal(calcAnsCommission(500, rate), 2);
});

test('calcAnsCommission: percentage above Rs1000', () => {
  const rate = { ansPct: 0.6, ansFlatBelow1000: 2 };
  // (10000 * 0.6) / 100 = 60
  assert.equal(calcAnsCommission(10000, rate), 60);
});

test('calcAnsCommission: percentage-based even at/below Rs1000 when no flat rate is set', () => {
  const rate = { ansPct: 0.2, ansFlatBelow1000: null };
  // (500 * 0.2) / 100 = 1
  assert.equal(calcAnsCommission(500, rate), 1);
});
