'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useCart } from '@/app/lib/cart-context';
import { ANALYTICS_EVENTS } from '@/app/lib/analytics';
import { track } from '@vercel/analytics';

export interface VariantOption {
  id: string;
  name: string;
  stockQuantity: number;
  availabilityStatus: string;
}

interface AddToCartButtonProps {
  productId: string;
  productName: string;
  stockQuantity: number;
  availabilityStatus: string;
  variants: VariantOption[];
}

const MAX_QTY = 99;

/**
 * Add-to-cart control for the product page. Stock clamping here is pure UX:
 * the real boundary is place_order() in PostgreSQL.
 */
export default function AddToCartButton({
  productId,
  productName,
  stockQuantity,
  availabilityStatus,
  variants,
}: AddToCartButtonProps) {
  const { addItem } = useCart();
  const hasVariants = variants.length > 0;

  const [variantId, setVariantId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);

  const selectedVariant = useMemo(
    () => variants.find((v) => v.id === variantId) ?? null,
    [variants, variantId]
  );

  // Variant products have no buyable stock until a variant is chosen: an
  // unselected variant is "unknown", never out-of-stock — otherwise the
  // selector below becomes unreachable (P0 2026-09-03: every variant
  // product rendered disabled «Немає в наявності» before a choice).
  const effectiveStock: number | null = hasVariants
    ? (selectedVariant?.stockQuantity ?? null)
    : stockQuantity;
  const outOfStock =
    availabilityStatus === 'out_of_stock' ||
    (effectiveStock !== null && effectiveStock <= 0) ||
    (hasVariants && selectedVariant?.availabilityStatus === 'out_of_stock');

  const maxQty = Math.max(1, Math.min(effectiveStock || MAX_QTY, MAX_QTY));

  if (outOfStock) {
    return (
      <button
        type="button"
        disabled
        className="w-full bg-gray-300 text-gray-600 py-3 rounded-lg font-semibold cursor-not-allowed"
      >
        Немає в наявності
      </button>
    );
  }

  if (added) {
    return (
      <div className="flex gap-3">
        <Link
          href="/cart"
          className="flex-1 text-center bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition"
        >
          У кошику — перейти
        </Link>
        <button
          type="button"
          onClick={() => setAdded(false)}
          className="px-4 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
        >
          Ще
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {hasVariants && (
        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">
            Варіант *
          </span>
          <select
            value={variantId}
            onChange={(e) => {
              setVariantId(e.target.value);
              setQuantity(1);
            }}
            className="w-full border border-gray-300 rounded-md p-2"
          >
            <option value="">— Оберіть варіант —</option>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.stockQuantity <= 0 ? ' (немає)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-700">Кількість:</span>
        <input
          type="number"
          min={1}
          max={maxQty}
          step={1}
          value={quantity}
          onChange={(e) => {
            const n = Number(e.target.value);
            setQuantity(Number.isInteger(n) ? n : 1);
          }}
          onBlur={() => {
            const n = Number.isInteger(quantity)
              ? Math.max(1, Math.min(quantity, maxQty))
              : 1;
            setQuantity(n);
          }}
          className="w-20 border border-gray-300 rounded-md p-2"
        />
        <span className="text-xs text-gray-400">макс. {maxQty}</span>
      </div>

      <button
        type="button"
        disabled={hasVariants && !selectedVariant}
        onClick={() => {
          if (hasVariants && !selectedVariant) return;
          const addedOk = addItem(productId, hasVariants ? variantId : null, quantity);
          // addItem is a no-op (returns false) for an out-of-range quantity
          // or a full cart — showing "У кошику" then would be a lie.
          if (!addedOk) return;
          // Anonymous analytics: product UUID only, no PII.
          track(ANALYTICS_EVENTS.ADD_TO_CART, { product_id: productId });
          setAdded(true);
        }}
        title={productName}
        className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Додати в кошик
      </button>
    </div>
  );
}
