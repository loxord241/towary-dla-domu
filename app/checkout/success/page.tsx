import Link from 'next/link';
import { createClient } from '@supabase/supabase-js';
import { verifyOrderAccessToken } from '@/app/lib/order-token';
import OrderDetailsCard from '@/app/components/OrderDetailsCard';
import OrderStatusBadge, {
  PaymentStatusBadge,
} from '@/app/components/OrderStatusBadge';
import PayWithLiqPayButton from '@/app/components/PayWithLiqPayButton';

/**
 * Order confirmation page. The total/currency/items shown here are ALWAYS
 * re-read from the database server-side after verifying an HMAC capability
 * token — nothing is trusted from the query string except the order number
 * plus its unguessable token pair.
 */

// Service role stays server-side; used here only to read the confirmed order.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

type SearchParams = Promise<{ order?: string; t?: string }>;

interface OrderRow {
  order_number: string;
  status: string;
  payment_status: string;
  subtotal: number;
  shipping_total: number;
  total_amount: number;
  currency: string;
  email: string;
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

function NotFound() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center p-8 bg-white rounded-lg shadow">
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Замовлення не знайдено</h1>
        <Link href="/catalog" className="text-blue-600 hover:underline">
          До каталогу
        </Link>
      </div>
    </div>
  );
}

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { order, t } = await searchParams;
  const orderNumber = typeof order === 'string' ? order : '';

  if (!verifyOrderAccessToken(orderNumber, t)) {
    return <NotFound />;
  }

  // Fresh read from the DB — never trust anything client-side.
  const orderRes = await supabase
    .from('orders')
    .select(
      'id, order_number, status, payment_status, subtotal, shipping_total, total_amount, currency, email, created_at'
    )
    .eq('order_number', orderNumber)
    .maybeSingle();

  const orderData = (orderRes.data ?? null) as (OrderRow & { id: string }) | null;
  if (!orderData) {
    return <NotFound />;
  }

  const itemsRes = await supabase
    .from('order_items')
    .select('product_name, sku, variant_name, quantity, price, total')
    .eq('order_id', orderData.id);

  const items = (itemsRes.data ?? []) as ItemRow[];

  const orderRow: OrderRow = {
    order_number: orderData.order_number,
    status: orderData.status,
    payment_status: orderData.payment_status,
    subtotal: orderData.subtotal,
    shipping_total: orderData.shipping_total,
    total_amount: orderData.total_amount,
    currency: orderData.currency,
    email: orderData.email,
    created_at: orderData.created_at,
  };

  const payment = orderRow.payment_status;

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="card mx-auto max-w-xl overflow-hidden">
        <div
          className={`border-b p-6 text-center ${
            payment === 'paid'
              ? 'bg-green-50 border-green-100'
              : 'bg-blue-50 border-blue-100'
          }`}
        >
          {payment === 'paid' ? (
            <>
              <div className="text-4xl mb-2">✓</div>
              <h1 className="text-2xl font-bold text-green-700 mb-1">
                Оплату отримано!
              </h1>
              <p className="text-sm text-gray-600">
                Замовлення{' '}
                <span className="font-mono font-semibold">{orderRow.order_number}</span>{' '}
                успішно оплачено.
              </p>
            </>
          ) : (
            <>
              <div className="text-4xl mb-2">✓</div>
              <h1 className="text-2xl font-bold text-gray-900 mb-1">Замовлення прийнято!</h1>
              <p className="text-sm text-gray-600">
                Номер замовлення:{' '}
                <span className="font-mono font-semibold">{orderRow.order_number}</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Збережіть номер — статус можна перевірити{' '}
                <Link href="/orders/lookup" className="underline hover:text-blue-600">
                  за номером та email
                </Link>
                .
              </p>
            </>
          )}
        </div>

        <OrderDetailsCard order={orderRow} items={items} />

        <div className="flex flex-wrap items-center gap-2 px-6 pb-2">
          <OrderStatusBadge status={orderRow.status} />
          <PaymentStatusBadge status={orderRow.payment_status} />
        </div>

        <div className="px-6 pb-4">
          {payment === 'paid' ? null : payment === 'pending' ? (
            <div className="rounded-lg bg-amber-50 p-4 text-sm">
              <p className="font-semibold text-amber-900">Оплату обробляється</p>
              <p className="mt-1 text-amber-800/90">
                Ми чекаємо підтвердження від платіжної системи. Якщо оплата вже
                здійснена, статус оновиться найближчим часом.
              </p>
              <Link
                href={`/checkout/success?order=${encodeURIComponent(orderRow.order_number)}&t=${encodeURIComponent(typeof t === 'string' ? t : '')}`}
                className="mt-2 inline-block text-sm font-medium underline text-amber-900"
              >
                Оновити статус
              </Link>
            </div>
          ) : payment === 'unpaid' || payment === 'failed' ? (
            <PayWithLiqPayButton
              orderNumber={orderRow.order_number}
              accessToken={typeof t === 'string' ? t : ''}
            />
          ) : null}
          {payment !== 'paid' && (
            <div className="rounded-lg bg-blue-50 p-4 text-sm">
              <p className="font-semibold text-blue-900">Що далі?</p>
              <ol className="mt-1 list-inside list-decimal space-y-0.5 text-blue-800/90">
                <li>Менеджер зв’яжеться з вами для підтвердження.</li>
                <li>Після підтвердження узгодимо доставку та оплату.</li>
                <li>Статус можна перевірити за номером замовлення.</li>
              </ol>
            </div>
          )}
        </div>

        {payment === 'failed' && (
          <p className="px-6 pb-4 text-sm text-red-600">
            Остання спроба оплати не була успішною. Ви можете повторити оплату
            кнопкою вище.
          </p>
        )}

        <div className="px-6 pb-6">
          <Link href="/catalog" className="btn btn-primary w-full py-3 text-base">
            Продовжити покупки
          </Link>
        </div>
      </div>
    </div>
  );
}
