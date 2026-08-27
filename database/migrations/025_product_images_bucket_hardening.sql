-- 025: security hardening — bucket-level limits for product_images
-- (2026-08-27 security hardening stage).
--
-- WHY:
--   The bucket previously had public=true, file_size_limit=null,
--   allowed_mime_types=null. Application-level defenses already exist
--   (MIME whitelist + magic-byte sniffing + 5 MB cap + sanitized object
--   names, app/api/admin/products/[id]/images/route.ts), but defense in
--   depth requires the Storage layer itself to enforce the same contract:
--   a future/bypassing write path (dashboard upload, new endpoint, leaked
--   key misuse) would otherwise face NO size or type limits at bucket level.
--
-- SETTINGS (mirror the application exactly, nothing wider):
--   * file_size_limit = 5242880 (5 MB) — identical to the app's
--     MAX_FILE_SIZE in the upload route;
--   * allowed_mime_types = the five formats the upload endpoint actually
--     accepts and magic-byte-verifies (JPEG/PNG/WebP/GIF/AVIF). SVG and
--     HTML are deliberately NOT allowed: the architecture blocks them
--     (stored-XSS risk on a publicly served bucket).
--
-- SAFETY:
--   * public=true is INTENTIONALLY preserved — public read is part of the
--     image display mechanism (getPublicImageUrl); write stays closed;
--   * all existing objects keep working (limits apply to new uploads);
--   * the upload route only produces objects within these limits, so no
--     legitimate flow can be rejected.
--
-- Idempotent: a plain UPDATE with constant values.

begin;

update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array[
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/avif'
    ]
where id = 'product_images';

commit;
