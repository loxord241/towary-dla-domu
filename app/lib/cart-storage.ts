/**
 * Pure cart-storage helpers — no React, no DOM. Imported by cart-context
 * (browser) and directly unit-testable in Node.
 */

export interface CartItem {
  productId: string;
  variantId: string | null;
  quantity: number;
}

export const CART_STORAGE_KEY = 'eshop-cart-v1';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_CART_LINES = 20;
export const MAX_ITEM_QUANTITY = 99;

export function lineKey(productId: string, variantId: string | null): string {
  return `${productId}::${variantId ?? ''}`;
}

export function clampQuantity(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_ITEM_QUANTITY) return null;
  return value;
}

/**
 * Defensive parse of persisted data: broken JSON is handled by the caller
 * (JSON.parse throws); here we reject wrong shapes, non-uuid ids,
 * NaN/fractional/negative/zero/huge quantities, merge duplicates (capped)
 * and strip every unknown field.
 */
export function sanitizeStoredCart(raw: unknown): CartItem[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, CartItem>();

  for (const entry of raw.slice(0, MAX_CART_LINES * 2)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const productId = typeof rec.productId === 'string' ? rec.productId : '';
    const rawVariant = rec.variantId;
    const variantId =
      typeof rawVariant === 'string' && rawVariant.length > 0 ? rawVariant : null;
    const quantity = clampQuantity(rec.quantity);

    if (!UUID_RE.test(productId)) continue;
    if (variantId !== null && !UUID_RE.test(variantId)) continue;
    if (quantity === null) continue;

    const key = lineKey(productId, variantId);
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity = Math.min(MAX_ITEM_QUANTITY, existing.quantity + quantity);
    } else {
      byKey.set(key, { productId, variantId, quantity });
    }
    if (byKey.size >= MAX_CART_LINES) break;
  }

  return [...byKey.values()];
}
