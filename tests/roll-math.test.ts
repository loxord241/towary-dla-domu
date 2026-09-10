/**
 * Unit tests for the pure wallpaper roll calculator
 * (app/lib/wallpapers/roll-math.ts — plan 2026-09-10, phase 2).
 *
 * Every expected number is computed BY HAND and pinned: strips =
 * ceil(perimeter/width), stripLength = height (+0.3 with pattern),
 * stripsPerRoll = floor(rollLength/stripLength), rolls =
 * ceil(strips/stripsPerRoll).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRolls,
  PATTERN_ALLOWANCE_M,
  type RollDimensions,
} from '../app/lib/wallpapers/roll-math.ts';

const R5310: RollDimensions = { widthM: 0.53, lengthM: 10 };
const R5315: RollDimensions = { widthM: 0.53, lengthM: 15 };
const R10610: RollDimensions = { widthM: 1.06, lengthM: 10 };

// ---------------------------------------------------------------------------
// baseline math: 53×10, perimeter 18 m, height 2.7 m
// ---------------------------------------------------------------------------

test('roll-math: 53×10, P=18, H=2.7 → 34 strips, 3 per roll, 12 rolls', () => {
  // strips = ceil(18 / 0.53) = ceil(33.96…) = 34
  // strip = 2.7 → floor(10 / 2.7) = 3 → ceil(34 / 3) = 12
  assert.deepEqual(calculateRolls({
    wallPerimeterM: 18,
    wallHeightM: 2.7,
    roll: R5310,
    patternMatch: false,
  }), {
    strips: 34,
    stripLengthM: 2.7,
    stripsPerRoll: 3,
    rolls: 12,
    impossible: false,
  });
});

test('roll-math: strips round UP on a partial last strip (P=18.1 → 35)', () => {
  // ceil(18.1 / 0.53) = ceil(34.15…) = 35; per roll still 3 → ceil(35/3) = 12
  const calc = calculateRolls({
    wallPerimeterM: 18.1,
    wallHeightM: 2.7,
    roll: R5310,
    patternMatch: false,
  });
  assert.equal(calc.strips, 35);
  assert.equal(calc.rolls, 12);
});

test('roll-math: exact division stays exact (P=5.3 → 10 strips)', () => {
  // IEEE-754 hazard pinned by integer-cm arithmetic: ceil must be 10, not 11.
  const calc = calculateRolls({
    wallPerimeterM: 5.3,
    wallHeightM: 2.7,
    roll: R5310,
    patternMatch: false,
  });
  assert.equal(calc.strips, 10);
  assert.equal(calc.rolls, 4); // ceil(10 / 3)
});

// ---------------------------------------------------------------------------
// pattern allowance adds 0.3 m per strip
// ---------------------------------------------------------------------------

test('roll-math: PATTERN_ALLOWANCE_M is 0.3 m', () => {
  assert.equal(PATTERN_ALLOWANCE_M, 0.3);
});

test('roll-math: pattern match adds 0.3 m allowance and can raise the count', () => {
  // H=2.45: без підбору strip=2.45 → floor(10/2.45)=4 → ceil(34/4)=9;
  // з підбором  strip=2.75 → floor(10/2.75)=3 → ceil(34/3)=12.
  const base = calculateRolls({
    wallPerimeterM: 18,
    wallHeightM: 2.45,
    roll: R5310,
    patternMatch: false,
  });
  assert.deepEqual(
    { stripLengthM: base.stripLengthM, stripsPerRoll: base.stripsPerRoll, rolls: base.rolls },
    { stripLengthM: 2.45, stripsPerRoll: 4, rolls: 9 }
  );

  const matched = calculateRolls({
    wallPerimeterM: 18,
    wallHeightM: 2.45,
    roll: R5310,
    patternMatch: true,
  });
  assert.deepEqual(
    { stripLengthM: matched.stripLengthM, stripsPerRoll: matched.stripsPerRoll, rolls: matched.rolls },
    { stripLengthM: 2.75, stripsPerRoll: 3, rolls: 12 }
  );
});

test('roll-math: pattern match with a long roll keeps stripsPerRoll (15 m)', () => {
  // H=2.7 + 0.3 = 3.0 → floor(15/3) = 5, same as floor(15/2.7) = 5.
  const matched = calculateRolls({
    wallPerimeterM: 18,
    wallHeightM: 2.7,
    roll: R5315,
    patternMatch: true,
  });
  assert.equal(matched.stripsPerRoll, 5);
  assert.equal(matched.rolls, 7); // ceil(34 / 5)
});

// ---------------------------------------------------------------------------
// roll geometry variants
// ---------------------------------------------------------------------------

test('roll-math: metre-wide 1.06×10 halves the strip count (17 → 6 rolls)', () => {
  // strips = ceil(18 / 1.06) = ceil(16.98…) = 17 → floor(10/2.7) = 3 → ceil(17/3) = 6
  assert.deepEqual(calculateRolls({
    wallPerimeterM: 18,
    wallHeightM: 2.7,
    roll: R10610,
    patternMatch: false,
  }), {
    strips: 17,
    stripLengthM: 2.7,
    stripsPerRoll: 3,
    rolls: 6,
    impossible: false,
  });
});

test('roll-math: 53×15 roll gives 5 strips per roll at H=2.7 (7 rolls)', () => {
  const calc = calculateRolls({
    wallPerimeterM: 18,
    wallHeightM: 2.7,
    roll: R5315,
    patternMatch: false,
  });
  assert.equal(calc.stripsPerRoll, 5); // floor(15 / 2.7)
  assert.equal(calc.rolls, 7); // ceil(34 / 5)
});

test('roll-math: tiny perimeter → single strip, single roll', () => {
  const calc = calculateRolls({
    wallPerimeterM: 0.5,
    wallHeightM: 2.7,
    roll: R5310,
    patternMatch: false,
  });
  assert.equal(calc.strips, 1); // ceil(0.5 / 0.53) = 1
  assert.equal(calc.rolls, 1);
});

// ---------------------------------------------------------------------------
// impossible case: roll shorter than (or equal to) one strip
// ---------------------------------------------------------------------------

test('roll-math: roll shorter than wall height → impossible, rolls=null', () => {
  // strip = 10.5 m > 10 m roll → floor(10/10.5) = 0.
  assert.deepEqual(calculateRolls({
    wallPerimeterM: 18,
    wallHeightM: 10.5,
    roll: R5310,
    patternMatch: false,
  }), {
    strips: 34,
    stripLengthM: 10.5,
    stripsPerRoll: 0,
    rolls: null,
    impossible: true,
  });
});

test('roll-math: pattern allowance can push a strip past the roll length', () => {
  // H=9.8 + 0.3 = 10.1 > 10 → impossible; without the allowance it fits.
  const base = calculateRolls({
    wallPerimeterM: 18,
    wallHeightM: 9.8,
    roll: R5310,
    patternMatch: false,
  });
  assert.equal(base.impossible, false);
  assert.equal(base.stripsPerRoll, 1);

  const matched = calculateRolls({
    wallPerimeterM: 18,
    wallHeightM: 9.8,
    roll: R5310,
    patternMatch: true,
  });
  assert.equal(matched.impossible, true);
  assert.equal(matched.rolls, null);
  assert.equal(matched.stripLengthM, 10.1);
});

test('roll-math: exact fit boundary — strip == roll length → 1 per roll', () => {
  // H=10.0 exactly: floor(10/10) = 1 → valid, rolls = strips = 34.
  const calc = calculateRolls({
    wallPerimeterM: 18,
    wallHeightM: 10,
    roll: R5310,
    patternMatch: false,
  });
  assert.equal(calc.stripsPerRoll, 1);
  assert.equal(calc.rolls, 34);
});

// ---------------------------------------------------------------------------
// invalid inputs → total function, never throws
// ---------------------------------------------------------------------------

test('roll-math: zero/negative/NaN/Infinity inputs → impossible sentinel', () => {
  for (const perimeter of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const calc = calculateRolls({
      wallPerimeterM: perimeter,
      wallHeightM: 2.7,
      roll: R5310,
      patternMatch: false,
    });
    assert.deepEqual(calc, {
      strips: 0,
      stripLengthM: 0,
      stripsPerRoll: 0,
      rolls: null,
      impossible: true,
    });
  }
  for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const calc = calculateRolls({
      wallPerimeterM: 18,
      wallHeightM: height,
      roll: R5310,
      patternMatch: false,
    });
    assert.equal(calc.impossible, true);
    assert.equal(calc.rolls, null);
  }
});
