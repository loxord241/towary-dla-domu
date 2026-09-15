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

test('OG-IMAGE: catalog/oboi views repeat the default image inside their page-level og', async () => {
  // Audit 2026-09-13: these views now set openGraph themselves. A page-level
  // og object REPLACES the layout default wholesale (shallow metadata merge),
  // so the committed static image must be repeated — otherwise a category
  // link shared in Viber/Telegram ships without og:image at all.
  const { buildCatalogViewMetadata, buildWallpapersMetadata } = await import(
    '../app/lib/seo.ts'
  );
  const catalog = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
  });
  assert.deepEqual(catalog.openGraph!.images, ['/og-image.png']);
  const oboi = buildWallpapersMetadata();
  assert.deepEqual(oboi.openGraph!.images, ['/og-image.png']);
});

test('OG-R11: info pages carry their own canonical + full OG card (audit R11 2026-09-15)', () => {
  // These pages are the only sitemap entries without their own canonical/OG:
  // messenger previews showed the generic layout card whose og:title
  // disagreed with the page <title>. Each page now pins a self canonical
  // and repeats locale/type/siteName/image (shallow-merge rule as above).
  for (const route of ['about', 'contacts', 'delivery', 'returns', 'privacy', 'terms']) {
    const page = src(`app/${route}/page.tsx`);
    assert.match(
      page,
      new RegExp(`alternates:\\s*{\\s*canonical:\\s*'/${route}'`),
      `${route}: self canonical missing`
    );
    assert.match(page, /openGraph:\s*{/, `${route}: og object missing`);
    assert.match(page, /locale:\s*'uk_UA'/, `${route}: og.locale missing`);
    assert.match(page, /siteName:\s*'Товари для дому'/, `${route}: og.siteName missing`);
    assert.match(page, /images:\s*\['\/og-image\.png'\]/, `${route}: og.image missing`);
  }
});
