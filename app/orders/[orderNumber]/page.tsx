import Link from 'next/link';
import { createClient } from '@supabase/supabase-js';
import {
  verifyOrderAccessToken,
  verifyStoredAccessToken,
} from '@/app/lib/order-token';
import OrderDetailsCard from '@/app/components/OrderDetailsCard';
import OrderStatusBadge, {
  PaymentStatusBadge,
} from '@/app/components/OrderStatusBadge';
import PayWithLiqPayButton from '@/app/components/PayWithLiqPayButton';
import { isPendingAttemptStale } from '@/app/lib/payment/order-payment-update';
import {
  carrierLabel,
  trackingUrl,
} from '@/app/lib/order-tracking';
import {
  readNpTrackingApiKey,
  refreshNpStatuses,
} from '@/app/lib/np-tracking';

/**
 * Guest order view: /orders/<order_number>?t=<hmac token>.
 * The token is the capability; totals/items are always re-read from the DB
 * server-side — nothing is trusted from the URL except the verified pair.
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

type Params = Promise<{ orderNumber: string }>;
type SearchParams = Promise<{ t?: string }>;

interface OrderRow {
  order_number: string;
  status: string;
  payment_status: string;
  subtotal: number;
  shipping_total: number;
  total_amount: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  product_name: string;
  sku: string;
  variant_name: string | null;
  quantity: number;
  price: number;
  total: number;
}

interface ShipmentRow {
  id: string;
  service_type: string;
  carrier: string | null;
  ttn_number: string | null;
  np_status: string | null;
  np_status_checked_at: string | null;
}

function NotFound() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="text-center p-8 bg-white rounded-lg shadow">
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Замовлення не знайдено</h1>
        <p className="text-gray-600 mb-6">Перевірте посилання або скористайтеся пошуком.</p>
        <Link
          href="/orders/lookup"
          className="inline-block px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition mr-2"
        >
          Пошук замовлення
        </Link>
        <Link
          href="/catalog"
          className="inline-block px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition"
        >
          До каталогу
        </Link>
      </div>
    </div>
  );
}

export default async function GuestOrderViewPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { orderNumber: rawNumber } = await params;
  const { t } = await searchParams;
  // Malformed percent-encodings (e.g. "/orders/ORD-%") must yield the 404
  // view, not an unhandled URIError that breaks the route.
  let orderNumber = '';
  try {
    orderNumber = decodeURIComponent(rawNumber ?? '');
  } catch {
    return <NotFound />;
  }

  // Rotating tokens (migration 045): a row with a stored hash verifies
  // ONLY against that hash (the legacy HMAC died at the first rotation);
  // NULL-hash rows (never rotated) still accept the legacy deterministic
  // token — backward compatible for links issued before 2026-09-12.
  const row = await supabase
    .from('orders')
    .select('access_token_hash')
    .eq('order_number', orderNumber)
    .maybeSingle();
  const storedHash = (row.data as { access_token_hash?: string | null } | null)
    ?.access_token_hash ?? null;
  const tokenOk = storedHash
    ? verifyStoredAccessToken(t, storedHash)
    : verifyOrderAccessToken(orderNumber, t);
  if (!tokenOk) {
    return <NotFound />;
  }

  // Fresh server-side read — the URL pair authorizes viewing, never supplies data.
  const orderRes = await supabase
    .from('orders')
    .select(
      'id, order_number, status, payment_status, subtotal, shipping_total, total_amount, currency, created_at, updated_at, shipping_info, customer_info'
    )
    .eq('order_number', orderNumber)
    .maybeSingle();

  const orderData = (orderRes.data ?? null) as (OrderRow & {
    id: string;
    shipping_info: unknown;
    customer_info: { phone?: unknown } | null;
  }) | null;
  if (!orderData) {
    return <NotFound />;
  }

  const itemsRes = await supabase
    .from('order_items')
    .select('product_name, sku, variant_name, quantity, price, total')
    .eq('order_id', orderData.id);

  const items = (itemsRes.data ?? []) as ItemRow[];

  // Parcel tracking (owner 2026-09-13): every shipment with a non-empty
  // ttn_number gets a tracking link. Column whitelist, same service-role
  // server client as the order/items reads (anon SELECT is revoked).
  const shipmentsRes = await supabase
    .from('order_shipments')
    .select('id, service_type, carrier, ttn_number, np_status, np_status_checked_at')
    .eq('order_id', orderData.id)
    .order('shipment_index');
  const shipmentRows = (shipmentsRes.data ?? []) as ShipmentRow[];

  // Live NP statuses (owner task 2026-09-13): refresh the display cache
  // when stale, then re-read so the page renders the freshest answer. Any
  // provider failure degrades silently to the plain tracking link.
  const customerPhone =
    (orderData.customer_info as { phone?: unknown } | null)?.phone ?? null;
  await refreshNpStatuses(
    shipmentRows.map((s) => ({
      id: s.id,
      ttn_number: s.ttn_number,
      np_status: s.np_status,
      np_status_checked_at: s.np_status_checked_at,
      phone: typeof customerPhone === 'string' ? customerPhone : null,
    })),
    readNpTrackingApiKey(),
    async (shipmentId, status, checkedAtIso) => {
      await supabase
        .from('order_shipments')
        .update({ np_status: status, np_status_checked_at: checkedAtIso })
        .eq('id', shipmentId);
    }
  );
  const freshShipments = await supabase
    .from('order_shipments')
    .select('id, service_type, carrier, ttn_number, np_status, np_status_checked_at')
    .eq('order_id', orderData.id)
    .order('shipment_index');
  const rowsSource = ((freshShipments.data ?? null) ?? shipmentRows) as ShipmentRow[];

  const trackingRows = (rowsSource as ShipmentRow[])
    .map((s) => {
      const ttn = (s.ttn_number ?? '').trim();
      return {
        ttn,
        label: carrierLabel(s.service_type, s.carrier ?? null),
        url: trackingUrl(s.service_type, s.carrier ?? null, ttn),
        status: (s.np_status ?? '').trim(),
      };
    })
    .filter((r) => r.ttn !== '' && r.url !== null);

  const order: OrderRow = {
    order_number: orderData.order_number,
    status: orderData.status,
    payment_status: orderData.payment_status,
    subtotal: orderData.subtotal,
    shipping_total: orderData.shipping_total,
    total_amount: orderData.total_amount,
    currency: orderData.currency,
    created_at: orderData.created_at,
    updated_at: orderData.updated_at,
  };

  // Stale pending (>60 min with no terminal callback): the payment init
  // endpoint can safely re-check the provider now (lost-callback repair or
  // fresh attempt), so the retry button becomes available. A FRESH pending
  // attempt keeps only the status block — its provider session may be live.
  const pendingStale =
    order.payment_status === 'pending' && isPendingAttemptStale(orderData.updated_at);

  // Самовивіз з оплатою на місці: LiqPay-кнопка не показується взагалі —
  // оплата відбувається готівкою на точці видачі (намір їде в
  // shipping_info.delivery.paymentIntent, санитайзер whitelist-ить значення).
  const shippingInfo = orderData.shipping_info as Record<string, unknown> | null;
  const deliveryInfo =
    shippingInfo && typeof shippingInfo === 'object'
      ? (shippingInfo.delivery as Record<string, unknown> | null)
      : null;
  const cashOnPickup =
    deliveryInfo?.paymentIntent === 'cash_on_pickup';

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="card mx-auto max-w-xl overflow-hidden">
        <div className="border-b border-gray-100 p-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Ваше замовлення</h1>
          <p className="font-mono font-semibold text-gray-700">{order.order_number}</p>
          <p className="text-xs text-gray-500 mt-1">
            від {new Date(order.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC
          </p>
        </div>

        <OrderDetailsCard order={order} items={items} />

        {trackingRows.length > 0 && (
          <div className="px-6 pb-4">
            <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-4">
              <h2 className="text-sm font-semibold text-indigo-900 mb-2">
                Відстеження посилки
              </h2>
              {trackingRows.map((row, i) => (
                <div
                  key={`${row.ttn}-${i}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 text-sm"
                >
                  <span className="text-gray-600">{row.label}:</span>
                  <span className="font-mono font-semibold text-gray-900">{row.ttn}</span>
                  <a
                    href={row.url!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-700 underline font-medium hover:text-indigo-900"
                  >
                    Відстежити на сайті перевізника →
                  </a>
                  {row.status !== '' && (
                    <span className="w-full text-indigo-900">
                      <span className="font-medium">Статус:</span> {row.status}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 px-6 pb-2 text-xs text-gray-500">
          <OrderStatusBadge status={order.status} />
          <PaymentStatusBadge status={order.payment_status} />
        </div>

        <div className="px-6 pb-4">
          {cashOnPickup && (
            <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-sm text-green-800">
              Оплата при отриманні: готівкою на точці самовивоза.
            </div>
          )}
          {!cashOnPickup &&
            (order.payment_status === 'unpaid' ||
              order.payment_status === 'failed' ||
              pendingStale) && (
            <PayWithLiqPayButton
              orderNumber={order.order_number}
              accessToken={typeof t === 'string' ? t : ''}
            />
          )}
          {!cashOnPickup && order.payment_status === 'pending' && (
            <div className={`rounded-lg bg-amber-50 p-4 text-sm ${pendingStale ? 'mt-3' : ''}`}>
              <p className="font-semibold text-amber-900">Оплату обробляється</p>
              {pendingStale && (
                <p className="mt-1 text-amber-800/90">
                  Якщо оплата не була завершена, ви можете спробувати ще раз
                  кнопкою вище — спосіб оплати буде перевірено у платіжної
                  системи.
                </p>
              )}
              <Link
                href={`/orders/${encodeURIComponent(order.order_number)}?t=${encodeURIComponent(typeof t === 'string' ? t : '')}`}
                className="mt-2 inline-block text-sm font-medium underline text-amber-900"
              >
                Оновити статус
              </Link>
            </div>
          )}
          {order.payment_status === 'paid' && (
            <div className="rounded-lg bg-green-50 p-4 text-sm text-green-800">
              Оплату отримано — дякуємо!
            </div>
          )}
        </div>

        <div className="px-6 pb-6">
          <Link
            href="/catalog"
            className="block text-center w-full bg-blue-600 text-white py-3 rounded-md font-semibold hover:bg-blue-700 transition"
          >
            Продовжити покупки
          </Link>
        </div>
      </div>
    </div>
  );
}
