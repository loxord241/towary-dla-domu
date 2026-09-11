/**
 * Motion pins for the PDP gallery (2026-09 animation batch, group C).
 *
 * The gallery is a client component with JSX, which node:test cannot
 * execute directly — these are static SOURCE pins, following the
 * established ux-fixes/pagination-hardening pattern.
 *
 * Contracts pinned here:
 *  1. The main-image fade is GATED behind the first user-driven switch
 *     (changeCount > 0). The initial render is animation-free because that
 *     image is the preloaded LCP element of the PDP (stage 14).
 *  2. The fade is opacity-only, short (~200ms), and disabled under
 *     prefers-reduced-motion; the fixed h-96 box keeps zero CLS.
 *  3. LCP contract intact: main image keeps `preload` (Next 16 replacement
 *     for the deprecated `priority` prop), thumbnails stay lazy.
 *  4. Arrows + thumbnails animate with transition-colors (+ motion-reduce).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gallery = readFileSync(
  path.join(root, 'app/components/ProductGallery.tsx'),
  'utf8'
);

// The fade classes live in exactly one place: the `mainMotion` expression.
const motionBlock = gallery.match(/const mainMotion =[\s\S]*?;\n/)?.[0] ?? '';

test('gallery: fade is gated behind the first user-driven change', () => {
  // the change counter starts at 0 = "initial render"
  assert.match(gallery, /changeCount, setChangeCount\] = useState\(0\)/);
  // the motion class string is computed ONLY when changeCount > 0, with an
  // empty string on the else branch — the first render cannot carry any
  // animation class or visibility delay
  assert.match(gallery, /const mainMotion =\s*\n?\s*changeCount > 0\s*\?/);
  assert.match(motionBlock, /:\s*'';\s*$/m);
  // every user-driven path (arrows and thumbnails) bumps the counter
  assert.match(gallery, /const selectImage = /);
  assert.match(gallery, /setChangeCount\(\(c\) => c \+ 1\)/);
  assert.ok(!gallery.match(/onClick=\{\(\) => setSelected\(/),
    'selection must go through selectImage so the fade gate cannot be bypassed');
});

test('gallery: all fade classes live inside the gated mainMotion expression', () => {
  assert.ok(motionBlock.length > 0, 'mainMotion expression must exist');
  // fade-only classes must not leak outside the gated block
  for (const cls of [
    'transition-opacity',
    'duration-200',
    'ease-out',
    'opacity-0',
    'opacity-100',
  ]) {
    const total = (gallery.match(new RegExp(cls, 'g')) ?? []).length;
    const inBlock = (motionBlock.match(new RegExp(cls, 'g')) ?? []).length;
    assert.equal(total, inBlock, `"${cls}" must appear only in the gated block`);
    assert.ok(inBlock >= 1, `"${cls}" must be present`);
  }
  // motion-reduce opt-out: once in the gated block, once per control
  // (2 arrows + 1 thumbnail button) — 4 in total
  const reduce = (gallery.match(/motion-reduce:transition-none/g) ?? []).length;
  assert.equal(reduce, 4,
    'motion-reduce:transition-none on the fade + arrows + thumbnails');
});

test('gallery: fade is opacity-only and the LCP box keeps zero CLS', () => {
  assert.doesNotMatch(motionBlock, /scale-|translate-|animate-/,
    'fade must not rely on transform/keyframe animation classes');
  // fixed main-image box: opacity changes must not shift layout
  // (mobile fix 2026-09-11: h-64 on mobile, sm:h-96 from the sm breakpoint —
  // the box stays fixed per breakpoint, so CLS stays zero)
  assert.match(gallery, /w-full h-64 object-contain sm:h-96/);
  // fade replays per switch via a keyed remount settling on image load
  assert.match(gallery, /key=\{main\.url\}/);
  assert.match(gallery, /onLoad=\{\(\) => setSettledUrl\(main\.url\)\}/);
});

test('gallery: LCP contract intact — main image preloaded, thumbnails lazy', () => {
  // main image keeps the Next 16 preload prop (replacement for `priority`)
  assert.match(gallery, /^\s+preload\s*$/m);
  // thumbnail strip must not eager/preload anything
  const thumbStart = gallery.indexOf('images.map((img, idx)');
  assert.ok(thumbStart > 0, 'thumbnail map must exist');
  const thumbBlock = gallery.slice(thumbStart);
  assert.doesNotMatch(thumbBlock, /preload/);
  assert.doesNotMatch(thumbBlock, /loading="eager"/);
  assert.match(thumbBlock, /sizes="80px"/);
});

test('gallery: arrows and thumbnails animate colors with motion-reduce opt-out', () => {
  // both arrows + the thumbnail button
  const colorTransitions = gallery.match(
    /transition-colors motion-reduce:transition-none/g
  ) ?? [];
  assert.ok(colorTransitions.length >= 3,
    'arrows (2) and thumbnail buttons (1) must each carry transition-colors');
  // arrows keep their hover background change
  assert.equal((gallery.match(/hover:bg-white/g) ?? []).length, 2);
  // selected thumbnail keeps the ring/border treatment
  assert.match(gallery, /border-blue-600 ring-1 ring-blue-400/);
  assert.match(gallery, /border-gray-200 hover:border-gray-400/);
});
