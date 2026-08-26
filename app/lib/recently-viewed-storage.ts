/**
 * Pure recently-viewed storage — no React, no direct DOM access. Imported by
 * the tracker/shelf client islands and unit-tested in Node.
 *
 * Privacy: stores ONLY anonymous product UUIDs — no names, prices, sessions
 * or identifiers of any kind.
 */

export const RECENTLY_VIEWED_STORAGE_KEY = 'eshop-recently-viewed-v1';

export const MAX_RECENTLY_VIEWED = 8;

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Defensive parse of persisted data: keep only well-formed UUIDs, preserve
 * stored order (most recent first), drop duplicates keeping the FIRST
 * occurrence (the position that reflects recency), cap at the limit.
 */
export function sanitizeRecentlyViewed(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw.slice(0, MAX_RECENTLY_VIEWED * 2)) {
    if (typeof entry !== 'string' || !UUID_RE.test(entry)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= MAX_RECENTLY_VIEWED) break;
  }
  return out;
}

/** localStorage.getItem adapter: broken/absent JSON degrades to []. */
export function readRecentlyViewed(get: (key: string) => string | null): string[] {
  let raw: string | null;
  try {
    raw = get(RECENTLY_VIEWED_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    return sanitizeRecentlyViewed(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** localStorage.setItem adapter: quota/private-mode failures are swallowed. */
export function writeRecentlyViewed(
  set: (key: string, value: string) => void,
  ids: string[]
): void {
  try {
    set(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable (private mode/quota): the shelf simply stays empty.
  }
}

/**
 * Record a product view: newest first, no duplicates, oldest evicted past 8.
 * An invalid product id is a no-op (never poison the stored list).
 */
export function recordRecentlyViewed(ids: string[], productId: string): string[] {
  if (!UUID_RE.test(productId)) return sanitizeRecentlyViewed(ids);
  const next = [productId, ...ids.filter((id) => id !== productId)];
  return next.slice(0, MAX_RECENTLY_VIEWED);
}
