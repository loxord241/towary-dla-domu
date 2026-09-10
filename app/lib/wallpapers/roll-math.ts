/**
 * Roll-quantity calculator for wallpaper product pages («як на Славі»),
 * wallpapers import phase 2 (plan 2026-09-10, spec §7).
 *
 * Standard spaler-shop methodology:
 *   strips        = ceil(wallPerimeterM / roll.widthM)
 *   stripLengthM  = wallHeightM + (patternMatch ? 0.3 : 0)   // rapport allowance
 *   stripsPerRoll = floor(roll.lengthM / stripLengthM)
 *   rolls         = ceil(strips / stripsPerRoll)
 *
 * Degenerate case: when a single strip does not fit into the roll at all
 * (stripsPerRoll === 0 — roll shorter than the wall height), `rolls` is
 * null and `impossible` is true; the UI must show an explanatory message
 * instead of a recommendation.
 *
 * All length arithmetic runs in INTEGER centimetres: IEEE-754 binary
 * fractions make ceil/floor treacherous near integers (e.g. a naive
 * 5.3/0.53 may land on either side of 10 depending on the operand order).
 * Centimetre inputs are pre-rounded (users type ≤2 decimals), so every
 * subsequent division is exact double arithmetic on integers.
 *
 * Pure module — no React, no Next.js, no DB. Unit-tested with node:test
 * (tests/roll-math.test.ts) and safe to import from client components.
 */

/** Allowed roll geometries (mirrors RollSize from parse.ts, in metres). */
export interface RollDimensions {
  widthM: 0.53 | 1.06;
  lengthM: 10 | 15;
}

export interface RollCalcInput {
  /** Perimeter of the room along the walls, metres, > 0. */
  wallPerimeterM: number;
  /** Wall height (floor → ceiling), metres, > 0. */
  wallHeightM: number;
  roll: RollDimensions;
  /** Patterned wallpaper needing rapport matching — adds a 0.3 m allowance. */
  patternMatch: boolean;
}

export interface RollCalculation {
  /** Total strips needed to cover the perimeter. */
  strips: number;
  /** Length of one strip incl. the pattern allowance, metres. */
  stripLengthM: number;
  /** Whole strips obtainable from one roll. */
  stripsPerRoll: number;
  /** Recommended rolls, or null when the calculation is impossible. */
  rolls: number | null;
  /** true → rolls is null (invalid input, or roll shorter than one strip). */
  impossible: boolean;
}

/** Extra length per strip for pattern-matched (rapport) wallpaper. */
export const PATTERN_ALLOWANCE_M = 0.3;

const CM_PER_M = 100;
const PATTERN_ALLOWANCE_CM = Math.round(PATTERN_ALLOWANCE_M * CM_PER_M); // 30

const IMPOSSIBLE: RollCalculation = {
  strips: 0,
  stripLengthM: 0,
  stripsPerRoll: 0,
  rolls: null,
  impossible: true,
};

/**
 * Total function: never throws. Non-finite / non-positive inputs degrade to
 * the `impossible` sentinel so the caller can render a neutral state.
 */
export function calculateRolls(input: RollCalcInput): RollCalculation {
  if (
    !Number.isFinite(input.wallPerimeterM) ||
    !Number.isFinite(input.wallHeightM)
  ) {
    return IMPOSSIBLE;
  }

  const perimeterCm = Math.round(input.wallPerimeterM * CM_PER_M);
  const heightCm = Math.round(input.wallHeightM * CM_PER_M);
  const widthCm = Math.round(input.roll.widthM * CM_PER_M);
  const rollLengthCm = Math.round(input.roll.lengthM * CM_PER_M);

  if (perimeterCm <= 0 || heightCm <= 0 || widthCm <= 0 || rollLengthCm <= 0) {
    return IMPOSSIBLE;
  }

  const strips = Math.ceil(perimeterCm / widthCm);
  const stripLengthCm = heightCm + (input.patternMatch ? PATTERN_ALLOWANCE_CM : 0);
  const stripsPerRoll = Math.floor(rollLengthCm / stripLengthCm);

  if (stripsPerRoll < 1) {
    // A single strip does not fit into the roll — no honest recommendation.
    return {
      strips,
      stripLengthM: stripLengthCm / CM_PER_M,
      stripsPerRoll,
      rolls: null,
      impossible: true,
    };
  }

  return {
    strips,
    stripLengthM: stripLengthCm / CM_PER_M,
    stripsPerRoll,
    rolls: Math.ceil(strips / stripsPerRoll),
    impossible: false,
  };
}
