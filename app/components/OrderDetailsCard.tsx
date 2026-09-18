import { formatPrice } from '@/app/lib/format';
import { isMeterProduct } from '@/app/lib/domains';
import ItemReviewForm from './ItemReviewForm';

interface OrderDetails {
  order_number: string;
  status: string;
  payment_status: string;
  subtotal: number;
  shipping_total: number;
  total_amount: number;
  currency: string;
  created_at: string;
}

interface ItemRow {
  /** Absent on the guest order-view page (legacy select). */
  product_id?: string | null;
  product_name: string;
  sku: string;
  variant_name: string | null;
  quantity: number;
  price: number;
  total: number;
}

/**
 * Presentational order summary shared by the checkout success page and the
 * guest order-view page. Pure server component.
 *
 * On the checkout success page (`reviewable`) each item renders as photo +
 * name with an INLINE review widget under it (owner request 2026-09-13:
 * «фотку, текст красивее, а под ними 5 серых звёзд и место на отзыв»).
 * The guest order-view page keeps the compact table.
 */
export default function OrderDetailsCard({
  order,
  items,
  images,
  reviewable = false,
}: {
  order: OrderDetails;
  items: ItemRow[];
  /** product_id → public image URL (or null when the product has none). */
  images?: Record<string, string | null>;
  reviewable?: boolean;
}) {
  return (
    <div className="p-6">
      {reviewable ? (
        <ul className="mb-4 divide-y divide-gray-100">
          {items.map((item, idx) => {
            const image = item.product_id ? images?.[item.product_id] ?? null : null;
            return (
              <li key={idx} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-3">
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={image}
                      alt={item.product_name}
                      width={64}
                      height={64}
                      loading="lazy"
                      className="h-16 w-16 shrink-0 rounded-lg border border-gray-100 object-cover"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-lg font-semibold text-gray-400"
                    >
                      {item.product_name.slice(0, 1)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 [overflow-wrap:anywhere]">
                      {item.product_name}
                    </p>
                    {item.variant_name && (
                      <p className="text-xs text-gray-500">{item.variant_name}</p>
                    )}
                    <p className="mt-0.5 text-xs text-gray-400">
                      {item.quantity} {isMeterProduct(item.sku) ? 'пог. м' : 'шт'} × {formatPrice(item.price, order.currency)}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-gray-900">
                      {formatPrice(item.total, order.currency)}
                    </p>
                  </div>
                </div>
                {item.product_id && (
                  <ItemReviewForm
                    productId={item.product_id}
                    productName={item.product_name}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <table className="w-full text-sm mb-4">
          <tbody className="divide-y divide-gray-100">
            {items.map((item, idx) => (
              <tr key={idx}>
                <td className="wrap-anywhere py-2 pr-2">
                  {item.product_name}
                  {item.variant_name && (
                    <span className="text-gray-500"> · {item.variant_name}</span>
                  )}
                  <span className="block break-words text-xs text-gray-400 [overflow-wrap:anywhere]">
                    SKU: {item.sku} · {item.quantity} {isMeterProduct(item.sku) ? 'пог. м' : 'шт'} ×{' '}
                    {formatPrice(item.price, order.currency)}
                  </span>
                </td>
                <td className="py-2 text-right whitespace-nowrap">
                  {formatPrice(item.total, order.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <dl className="space-y-1 text-sm border-t border-gray-200 pt-3">
        <div className="flex justify-between text-gray-600">
          <dt>Товари</dt>
          <dd>{formatPrice(order.subtotal, order.currency)}</dd>
        </div>
        <div className="flex justify-between text-gray-600">
          <dt>Доставка</dt>
          <dd>{formatPrice(order.shipping_total, order.currency)}</dd>
        </div>
        <div className="flex justify-between font-bold text-base pt-1">
          <dt>Разом до сплати</dt>
          <dd>{formatPrice(order.total_amount, order.currency)}</dd>
        </div>
      </dl>

      <p className="mt-4 text-xs text-gray-400">
        Статус: {order.status} · оплата: {order.payment_status}
      </p>
    </div>
  );
}
