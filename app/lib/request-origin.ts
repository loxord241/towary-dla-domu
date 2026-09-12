/**
 * Same-origin gate for public POST endpoints (audit P1, 2026-09-12).
 *
 * Contract: a POST that CARRIES an Origin header must have it match the
 * deployment host (Host, or X-Forwarded-Host behind the edge proxy — the
 * same Vercel trust model documented at the top of app/lib/rate-limit.ts:
 * the edge overwrites these, they are not client-controlled on Vercel).
 *
 * Deliberately PERMISSIVE when Origin is ABSENT: curl, server-to-server
 * callers and non-browser clients never send Origin, and none of these
 * endpoints use cookie authentication — the classic login-CSRF does not
 * apply; the gate blocks cross-site browser posting (drive-by fetches
 * from third-party pages always carry Origin). Content-Type is NOT
 * required to be application/json: fetch-based cross-site posts can send
 * any simple content type, so the Origin check is the real signal.
 *
 * Returns true = proceed, false = answer 403 forbidden_origin.
 */

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function assertSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null || origin === '') return true; // non-browser client
  const originHost = hostOf(origin);
  if (originHost === '') return false; // malformed Origin — fail closed

  const forwarded = request.headers.get('x-forwarded-host');
  const candidates = [
    request.headers.get('host'),
    ...(forwarded ? forwarded.split(',').map((h) => h.trim()) : []),
  ].filter((h): h is string => typeof h === 'string' && h !== '');

  return candidates.some((host) => host.toLowerCase() === originHost.toLowerCase());
}
