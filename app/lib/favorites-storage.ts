/**
 * Pure favorites-storage helpers — no React, no DOM. Mirrors cart-storage:
 * localStorage holds ONLY product identifiers; every display value comes
 * from the server (/api/cart-preview).
 */

export const FAVORITES_STORAGE_KEY = 'eshop-favorites-v1';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_FAVORITES = 200;

/**
 * Defensive parse of persisted favorites: broken JSON is handled by the
 * caller; here we keep only valid product ids, dedupe, cap the list and
 * strip unknown fields.
 */
export function sanitizeStoredFavorites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();

  for (const entry of raw.slice(0, MAX_FAVORITES * 2)) {
    if (typeof entry !== 'string') {
      // legacy/unknown shapes are ignored entirely — ids only by contract
      continue;
    }
    if (!UUID_RE.test(entry)) continue;
    seen.add(entry);
    if (seen.size >= MAX_FAVORITES) break;
  }

  return [...seen];
}
