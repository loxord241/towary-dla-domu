import { formatPrice } from '@/app/lib/format';

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
 */
export default function OrderDetailsCard({
  order,
  items,
}: {
  order: OrderDetails;
  items: ItemRow[];
}) {
  return (
    <div className="p-6">
      <table className="w-full text-sm mb-4">
        <tbody className="divide-y divide-gray-100">
          {items.map((item, idx) => (
            <tr key={idx}>
              <td className="py-2 pr-2">
                {item.product_name}
                {item.variant_name && (
                  <span className="text-gray-500"> · {item.variant_name}</span>
                )}
                <span className="block break-words text-xs text-gray-400 [overflow-wrap:anywhere]">
                  SKU: {item.sku} · {item.quantity} шт ×{' '}
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
