/**
 * Cart feedback motion contract (animation batch A, 2026-09-08).
 *
 * Static pins (node:test cannot mount JSX — established pattern, see
 * tests/checkout-carrier-select.test.ts):
 *
 *   - CartBadge/FavoritesBadge counter bubble «pop»: the JSX pins
 *     key={count}, so React remounts the bubble on every count change
 *     and the CSS keyframe restarts; zero-state hiding (count > 0)
 *     is kept;
 *   - pop/entry keyframes are transform/opacity-only and their classes
 *     live INSIDE @layer components, so the Tailwind utilities-layer
 *     `motion-reduce:animate-none` can switch them off;
 *   - AddToCartButton «У кошику — перейти» enters with fade + 4px rise;
 *   - every animated element carries a motion-reduce guard; color
 *     transitions are scoped to transition-colors (no bare `transition`
 *     utility left on the buttons);
 *   - CLS: the added block's intrinsic height matches the replaced
 *     button (both py-3 + font-semibold), and the swap is
 *     presentation-only — the addItem gate / limit-notice logic that
 *     security-remediation.test.ts pins is untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(path.join(root, p), 'utf8');

const CART_BADGE = src('app/components/CartBadge.tsx');
const FAV_BADGE = src('app/components/FavoritesBadge.tsx');
const ADD_BTN = src('app/components/AddToCartButton.tsx');
const GLOBALS = src('app/globals.css');

/** Full `{ … }` block of GLOBALS starting at `startIdx` (brace-counted). */
function cssBlock(startIdx: number): string {
  let depth = 0;
  for (let i = startIdx; i < GLOBALS.length; i++) {
    if (GLOBALS[i] === '{') depth++;
    else if (GLOBALS[i] === '}') {
      depth--;
      if (depth === 0) return GLOBALS.slice(startIdx, i + 1);
    }
  }
  assert.fail(`css block at ${startIdx} never closes`);
}

/** Body of a `@keyframes NAME` rule from globals.css. */
function keyframes(name: string): string {
  const start = GLOBALS.indexOf(`@keyframes ${name}`);
  assert.notEqual(start, -1, `@keyframes ${name} must exist in globals.css`);
  return cssBlock(start);
}

// ------------------------------------------------------------------
// Badge pop: remount on count change + reduced-motion guard
// ------------------------------------------------------------------

for (const [name, source] of [
  ['CartBadge', CART_BADGE],
  ['FavoritesBadge', FAV_BADGE],
] as const) {
  test(`${name}: counter bubble pops via key={count} remount, motion-reduce safe`, () => {
    // key on the bubble → React remounts it on every count change →
    // the badge-pop animation restarts
    assert.match(
      source,
      /<span\s+key=\{count\}\s+className="badge-pop motion-reduce:animate-none absolute/,
      'bubble must pin key={count} and carry badge-pop + animate-none guard'
    );
    // exactly one bubble render site (the pop must not double-fire);
    // count class usages, not comments
    assert.equal(
      (source.match(/className="badge-pop/g) ?? []).length,
      1
    );
    // zero-state hiding is kept (existing ux-fixes pin, restated here)
    assert.match(source, /count > 0 &&/);
  });
}

// ------------------------------------------------------------------
// globals.css: transform/opacity-only keyframes, layered for override
// ------------------------------------------------------------------

const LAYOUT_PROPS =
  /(?:^|[^-a-z])(width|height|top|left|right|bottom|margin|padding)\s*:/;

test('GLOBALS: badge-pop keyframe is scale 1→1.25→1, transform-only', () => {
  const kf = keyframes('badge-pop');
  assert.match(kf, /0% \{ transform: scale\(1\); \}/);
  assert.match(kf, /50% \{ transform: scale\(1\.25\); \}/);
  assert.match(kf, /100% \{ transform: scale\(1\); \}/);
  assert.doesNotMatch(kf, LAYOUT_PROPS, 'pop must not animate layout');
  const cls = cssBlock(GLOBALS.indexOf('.badge-pop'));
  assert.match(cls, /animation: badge-pop 220ms ease-out;/);
});

test('GLOBALS: added-in keyframe is opacity + translateY(4px→0), ~200ms', () => {
  const kf = keyframes('added-in');
  assert.match(kf, /opacity: 0;/);
  assert.match(kf, /transform: translateY\(4px\);/);
  assert.match(kf, /transform: translateY\(0\);/);
  assert.doesNotMatch(kf, LAYOUT_PROPS, 'entry must not animate layout');
  const cls = cssBlock(GLOBALS.indexOf('.added-in'));
  assert.match(cls, /animation: added-in 200ms ease-out;/);
});

test('GLOBALS: motion classes live in @layer components so utilities override them', () => {
  // unlayered CSS would beat the utilities layer and defeat
  // motion-reduce:animate-none — the classes must be layered
  const layerStart = GLOBALS.indexOf('@layer components');
  assert.notEqual(layerStart, -1);
  assert.ok(
    layerStart < GLOBALS.indexOf('.badge-pop') &&
      layerStart < GLOBALS.indexOf('.added-in'),
    '.badge-pop/.added-in must be defined inside @layer components'
  );
});

// ------------------------------------------------------------------
// AddToCartButton: added-state entry + color transitions
// ------------------------------------------------------------------

test('ADDED: «У кошику — перейти» block enters with fade+rise, motion-reduce safe', () => {
  assert.match(
    ADD_BTN,
    /className="added-in motion-reduce:animate-none flex gap-3"/,
    'the added wrapper must carry the entry class + animate-none guard'
  );
  // equal intrinsic height → the swap cannot shift layout (CLS=0)
  assert.match(
    ADD_BTN,
    /bg-green-600 text-white py-3 rounded-lg font-semibold/,
    'added Link keeps py-3 + font-semibold like the replaced button'
  );
});

test('BTN: color transitions are scoped and guarded; no bare transition left', () => {
  // both color-animating elements (green added Link + blue add button)
  assert.equal(
    (ADD_BTN.match(/transition-colors motion-reduce:transition-none/g) ?? [])
      .length,
    2,
    'added Link and add button must both guard their color transition'
  );
  // a bare `transition` (animates opacity/box-shadow/… too) must not remain
  const bare = ADD_BTN.match(/(?:^|[^-a-z:])transition(?![-a-z])/g) ?? [];
  assert.equal(bare.length, 0, 'bare transition utility must be gone');
});

test('BTN: presentation-only change — cart logic untouched', () => {
  // the gates security-remediation.test.ts pins must still be here
  assert.match(ADD_BTN, /const addedOk = addItem\(/);
  assert.match(ADD_BTN, /if \(!addedOk\) \{/);
  assert.match(ADD_BTN, /setAdded\(true\)/);
  assert.match(ADD_BTN, /У кошику максимум/);
});
