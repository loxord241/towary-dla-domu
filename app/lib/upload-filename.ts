/**
 * Storage upload filename hardening (2026-08-27 security stage).
 *
 * The admin image upload route validates MIME via a whitelist + magic bytes
 * and enforces a 5 MB cap before anything reaches Storage. The stored object
 * NAME must be hardened too:
 *   - the extension is taken from a whitelist mapped to the detected MIME
 *     type, never from the client-supplied filename (a lying or dangerous
 *     extension like .html/.svg/.php cannot survive into Storage paths);
 *   - the extension always MATCHES the magic-byte-verified content type;
 *   - safe existing names keep working: the base goes through the same
 *     sanitization as before (lowercase, [a-z0-9-_], length-capped) and a
 *     correct extension produces an unchanged result apart from casing.
 *
 * SVG/HTML are deliberately absent — the upload architecture blocks them
 * (stored XSS via <script> in SVG served from a public bucket).
 */

/** Canonical file extension for every MIME type the upload endpoint accepts. */
export const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/**
 * Builds a safe Storage object name from the client-supplied filename and
 * the server-verified content type. Returns null when the content type is
 * not in the whitelist (caller should reject the upload).
 */
export function sanitizeUploadFileName(
  rawName: string,
  detectedMime: string
): string | null {
  const ext = IMAGE_EXT_BY_MIME[detectedMime];
  if (!ext) return null;

  const dot = rawName.lastIndexOf('.');
  const base = dot > 0 ? rawName.slice(0, dot) : rawName;
  const safeBase =
    base
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'image';
  return `${safeBase}${ext}`;
}
