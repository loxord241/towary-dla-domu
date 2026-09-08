/**
 * Static invariants for the modal entry animation + hover consistency batch
 * (group B, 2026-09 animation audit).
 *
 * JSX is not executable in node:test (established pattern), so these tests
 * pin the SOURCE invariants:
 *
 *  - both storefront modals (ReviewFormModal, FeedbackModal) share ONE entry
 *    pattern, identical to NavDrawer/CatalogFilters: overlay fades via
 *    `transition-opacity` (200ms), panel fades + scales via
 *    `transition-[opacity,scale]` (95% → 100%, ~200ms);
 *  - every animated element carries `motion-reduce:transition-none`;
 *  - exit stays instant: no unmount-timer choreography;
 *  - a11y/anti-spam invariants survive untouched: dialog semantics, focus
 *    trap refs, Escape, body scroll lock, honeypot, no dangerouslySetInnerHTML;
 *  - hover consistency: the group-hover title color change on ProductCard
 *    and the home category cards transitions via `transition-colors`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MODALS = [
  'app/components/ReviewFormModal.tsx',
  'app/components/FeedbackModal.tsx',
];

// ---- modal entry animation (overlay)

test('MODAL MOTION: both modals fade the overlay in over 200ms (transition-opacity)', () => {
  for (const file of MODALS) {
    const modal = src(file);
    assert.match(
      modal,
      /bg-black\/40 transition-opacity duration-200 ease-out motion-reduce:transition-none/,
      `${file}: overlay must fade via transition-opacity 200ms with motion-reduce opt-out`
    );
    assert.match(
      modal,
      /shown \? 'opacity-100' : 'pointer-events-none opacity-0'/,
      `${file}: overlay must start hidden (opacity-0) and flip to opacity-100`
    );
  }
});

// ---- modal entry animation (panel)

test('MODAL MOTION: panel enters with opacity + scale-95→100 (~200ms)', () => {
  for (const file of MODALS) {
    const modal = src(file);
    assert.match(
      modal,
      /transition-\[opacity,scale\] duration-200 ease-out motion-reduce:transition-none/,
      `${file}: panel must transition opacity + scale only (Tailwind v4 scale is the native CSS property)`
    );
    assert.match(
      modal,
      /shown \? 'scale-100 opacity-100' : 'scale-95 opacity-0'/,
      `${file}: panel must start at scale-95/opacity-0 and enter to scale-100/opacity-100`
    );
  }
});

// ---- entry choreography / exit stays instant

test('MODAL MOTION: entry flip is rAF-deferred (NavDrawer pattern), exit stays instant', () => {
  for (const file of MODALS) {
    const modal = src(file);
    // Double rAF: commit hidden styles first, then flip `shown` so the CSS
    // transition runs — never a synchronous setState in the effect body.
    assert.match(
      modal,
      /requestAnimationFrame\(\(\) => \{\s*raf2 = requestAnimationFrame\(\(\) => setShown\(true\)\);?\s*\}\)/,
      `${file}: entry must use the double-rAF pattern like NavDrawer`
    );
    // Closing resets `shown` so the next open animates again.
    assert.match(modal, /setShown\(false\)/, `${file}: shown must reset on close`);
    // No exit choreography: instant unmount (SiteHeader convention).
    assert.doesNotMatch(
      modal,
      /setTimeout\(/,
      `${file}: exit must stay instant — no unmount timer`
    );
  }
});

// ---- a11y / anti-spam invariants must survive the animation work

test('MODAL MOTION: dialog semantics, focus trap, scroll lock and honeypot intact', () => {
  for (const file of MODALS) {
    const modal = src(file);
    assert.match(modal, /role="dialog"/, `${file}: dialog role missing`);
    assert.match(modal, /aria-modal="true"/, `${file}: aria-modal missing`);
    assert.match(modal, /ref=\{dialogRef\}/, `${file}: focus-trap container ref missing`);
    assert.match(modal, /ref=\{closeBtnRef\}/, `${file}: initial-focus ref missing`);
    assert.match(modal, /Escape/, `${file}: Escape-to-close missing`);
    assert.match(
      modal,
      /document\.body\.style\.overflow = 'hidden'/,
      `${file}: body scroll lock missing`
    );
    assert.match(modal, /tabIndex=\{-1\}/, `${file}: honeypot must stay hidden`);
    assert.doesNotMatch(
      modal,
      /dangerouslySetInnerHTML/,
      `${file}: text children only — no HTML sinks`
    );
  }
});

// ---- hover consistency

test('HOVER: ProductCard title color change transitions (motion-reduce safe)', () => {
  const card = src('app/components/ProductCard.tsx');
  assert.match(
    card,
    /font-semibold text-gray-900 transition-colors motion-reduce:transition-none group-hover:text-blue-700/,
    'ProductCard h3 must pair transition-colors (+motion-reduce) with group-hover:text-blue-700'
  );
});

test('HOVER: home category card titles transition their color (motion-reduce safe)', () => {
  const home = src('app/(home)/page.tsx');
  assert.match(
    home,
    /font-semibold text-gray-900 transition-colors motion-reduce:transition-none group-hover:text-blue-700/,
    'home categories h3 must pair transition-colors (+motion-reduce) with group-hover:text-blue-700'
  );
});

// ---- batch-wide guardrails

test('MOTION: no CLS-prone or off-limits animation properties in batch files', () => {
  for (const file of [
    ...MODALS,
    'app/components/ProductCard.tsx',
    'app/(home)/page.tsx',
  ]) {
    const fileSrc = src(file);
    // Only transform/opacity/color may animate: no width/height/top/left
    // transitions introduced.
    assert.doesNotMatch(
      fileSrc,
      /transition-\[?(width|height|top|left|right|bottom|margin|padding)/,
      `${file}: layout properties must never transition (CLS)`
    );
  }
});
