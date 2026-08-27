/**
 * Storage hardening invariants (2026-08-27 security stage).
 *
 * Covers two layers:
 *  1. BEHAVIORAL: sanitizeUploadFileName (app/lib/upload-filename.ts) —
 *     whitelist-only extensions forced to match the server-verified MIME,
 *     safe names unchanged, no SVG/HTML anywhere in Storage paths.
 *  2. STRUCTURAL: the upload route must stay wired to the pure module, and
 *     migration 025 must keep the bucket limits in sync with the app
 *     (5 MB + exactly the five accepted image types, SVG/HTML excluded).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sanitizeUploadFileName, IMAGE_EXT_BY_MIME } from '../app/lib/upload-filename.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const ROUTE = 'app/api/admin/products/[id]/images/route.ts';
const MIGRATION = 'database/migrations/025_product_images_bucket_hardening.sql';

test('filename: canonical extension is forced from the detected MIME', () => {
  assert.equal(sanitizeUploadFileName('photo.png', 'image/png'), 'photo.png');
  assert.equal(sanitizeUploadFileName('photo.jpg', 'image/jpeg'), 'photo.jpg');
  assert.equal(
    sanitizeUploadFileName('PHOTO.JPG', 'image/jpeg'),
    'photo.jpg',
    'casing is normalized as before'
  );
  // Lying extensions are REPLACED by the content-true one, never kept:
  assert.equal(sanitizeUploadFileName('payload.html', 'image/jpeg'), 'payload.jpg');
  assert.equal(sanitizeUploadFileName('payload.svg', 'image/png'), 'payload.png');
  assert.equal(sanitizeUploadFileName('payload.php.txt', 'image/webp'), 'payload-php.webp');
});

test('filename: jpeg normalizes to .jpg (canonical map)', () => {
  assert.equal(sanitizeUploadFileName('a.jpeg', 'image/jpeg'), 'a.jpg');
  assert.equal(sanitizeUploadFileName('a.JPEG', 'image/jpeg'), 'a.jpg');
});

test('filename: unsafe base characters still sanitized as before', () => {
  assert.equal(sanitizeUploadFileName('My Photo #1!.png', 'image/png'), 'my-photo-1.png');
  assert.equal(sanitizeUploadFileName('../../etc/passwd.png', 'image/png'), 'etc-passwd.png');
  assert.equal(sanitizeUploadFileName('...png', 'image/png'), 'image.png');
  // 60-char base cap preserved (old sanitize behavior)
  const long = 'a'.repeat(100);
  assert.equal(sanitizeUploadFileName(`${long}.png`, 'image/png'), `${'a'.repeat(60)}.png`);
});

test('filename: unknown MIME type is rejected with null', () => {
  assert.equal(sanitizeUploadFileName('x.png', 'image/svg+xml'), null);
  assert.equal(sanitizeUploadFileName('x.png', 'text/html'), null);
  assert.equal(sanitizeUploadFileName('x.png', ''), null);
});

test('filename: no SVG/HTML in the extension whitelist', () => {
  for (const [mime, ext] of Object.entries(IMAGE_EXT_BY_MIME)) {
    assert.match(mime, /^image\/(jpeg|png|webp|gif|avif)$/);
    assert.match(ext, /^\.(jpg|png|webp|gif|avif)$/);
  }
  assert.equal(Object.keys(IMAGE_EXT_BY_MIME).length, 5);
});

test('route: ALLOWED_MIME mirrors the extension whitelist keys', () => {
  const route = src(ROUTE);
  assert.match(
    route,
    /const ALLOWED_MIME = Object\.keys\(IMAGE_EXT_BY_MIME\)/,
    'the route must derive its MIME whitelist from the pure module'
  );
  assert.match(route, /MAX_FILE_SIZE = 5 \* 1024 \* 1024/);
  assert.match(
    route,
    /sanitizeUploadFileName\(file\.name,\s*detectedMime\)/,
    'object names must be built from the magic-byte-verified type'
  );
  // The old keep-client-extension implementation must be gone.
  assert.doesNotMatch(route, /function sanitizeFileName/);
  assert.doesNotMatch(
    route.replace(/^\s*\*.*$/gm, ''),
    /name\.slice\(dot\)/,
    'client-controlled extensions must not reach the storage path'
  );
});

test('migration 025: bucket limits mirror the application', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('025_product_images_bucket_hardening.sql'),
    `expected ${MIGRATION}`
  );
  const m = src(MIGRATION);
  assert.match(m, /file_size_limit\s*=\s*5242880/);
  for (const mime of Object.keys(IMAGE_EXT_BY_MIME)) {
    assert.ok(m.includes(`'${mime}'`), `migration must allow ${mime}`);
  }
  assert.doesNotMatch(m, /image\/svg/i, 'SVG stays blocked at bucket level');
  assert.doesNotMatch(m, /text\/html/i, 'HTML stays blocked at bucket level');
  assert.doesNotMatch(
    m.replace(/^\s*--.*$/gm, ''),
    /public\s*=\s*(true|false)/,
    'public/private model must not be changed by this migration'
  );
});
