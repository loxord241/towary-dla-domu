/**
 * Open Graph image invariants (2026-08-27 stage).
 *
 * Social crawlers fetch og:image directly with no session/cookies/referer,
 * so every referenced image must be (a) real — resolvable without JS,
 * no invented URLs — and (b) served from origins already proven reachable
 * to anonymous clients.
 *
 * Strategy grounded in the actual storage architecture (all product
 * imagery lives as external b2b.yugcontract.ua hotlinks):
 *  - homepage + root layout default: committed static /og-image.png;
 *  - PDP: the product's REAL main image URL when one exists, resolved via
 *    the same getMainPublicImageUrl used by the visible gallery.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

test('OG-IMAGE: homepage advertises a real, existing static OG image', () => {
  assert.ok(
    existsSync(path.join(root, 'public', 'og-image.png')),
    'public/og-image.png must exist — a metadata URL pointing nowhere is worse than none'
  );
  const home = src('app/(home)/page.tsx');
  assert.match(home, /openGraph:\s*{[\s\S]*?images:\s*\[\s*'\/og-image\.png'/);
});

test('OG-IMAGE: root layout carries a default OG image for non-overriding pages', () => {
  assert.ok(existsSync(path.join(root, 'public', 'og-image.png')));
  const layout = src('app/layout.tsx');
  assert.match(layout, /images:\s*\[\s*'\/og-image\.png'/);
});

test('OG-IMAGE: PDP falls back to the real main product image', () => {
  const pdp = src('app/product/[slug]/page.tsx');
  assert.match(
    pdp,
    /getMainPublicImageUrl/,
    'PDP metadata must reuse the same main-image resolution as the gallery'
  );
  assert.match(pdp, /images:\s*mainImage\s*\?[^;]*\[mainImage\]/);
});

test('OG-IMAGE: static asset is a genuine 1200×630 PNG', () => {
  const buf = readFileSync(path.join(root, 'public', 'og-image.png'));
  // PNG signature + IHDR dims (width @ offset 16, height @ offset 20, BE u32)
  assert.ok(buf.length > 1000, 'file must be non-trivially sized');
  assert.equal(buf.subarray(0, 4).toString('hex'), '89504e47', 'PNG signature');
  assert.equal(buf.readUInt32BE(16), 1200, 'width');
  assert.equal(buf.readUInt32BE(20), 630, 'height');
});
