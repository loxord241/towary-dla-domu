'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Modal from '@/app/components/Modal';
import OrderStatusBadge, {
  PaymentStatusBadge,
} from '@/app/components/OrderStatusBadge';

interface OrderListRow {
  id: string;
  order_number: string;
  email: string;
  status: string;
  payment_status: string;
  total_amount: number;
  currency: string;
  customer_info: { name?: string; phone?: string | null } | null;
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

interface OrderDetails {
  id: string;
  order_number: string;
  email: string;
  status: string;
  payment_status: string;
  subtotal: number;
  shipping_total: number;
  total_amount: number;
  currency: string;
  customer_info: { name?: string; phone?: string | null } | null;
  shipping_info: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}

const STATUSES = [
  'pending',
  'confirmed',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
] as const;

// Mirror of the server-side transition map (server remains the authority).
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ['confirmed'],
  confirmed: ['shipped'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

const PAGE_SIZE = 50;

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
}

// Module-scope loaders (project react-hooks pattern): every state update
// happens inside async callbacks, never synchronously in an effect body.
async function fetchOrdersApi(
  filters: { status: string; q: string; page?: number },
  onData: (rows: OrderListRow[], totalCount: number) => void,
  onError: (message: string) => void,
  onDone: () => void
) {
  try {
    const search = new URLSearchParams();
    if (filters.status) search.set('status', filters.status);
    if (filters.q) search.set('q', filters.q);
    if (filters.page && filters.page > 1) search.set('page', String(filters.page));
    const res = await fetch(`/api/admin/orders?${search}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Не вдалося завантажити замовлення');
    onData(
      (data?.orders as OrderListRow[]) ?? [],
      typeof data?.total === 'number' ? data.total : 0
    );
  } catch (err) {
    onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

async function fetchOrderDetailsApi(
  id: string
): Promise<{ order: OrderDetails; items: ItemRow[] }> {
  const res = await fetch(`/api/admin/orders/${id}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'Failed to fetch order');
  return {
    order: data.order as OrderDetails,
    items: (data.items as ItemRow[]) ?? [],
  };
}

export default function OrdersAdminPage() {
  const [orders, setOrders] = useState<OrderListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Draft filter inputs; `applied` is the snapshot used by API calls,
  // so pagination switches never pick up unsubmitted text.
  const [statusFilter, setStatusFilter] = useState('');
  const [qInput, setQInput] = useState('');
  const [applied, setApplied] = useState<{ status: string; q: string }>({
    status: '',
    q: '',
  });
  const [page, setPage] = useState(1);

  // Details modal state.
  const [details, setDetails] = useState<{ order: OrderDetails; items: ItemRow[] } | null>(null);
  const [detailsBusy, setDetailsBusy] = useState(false);

  const applyFilters = (
    next: { status: string; q: string },
    targetPage: number
  ) => {
    setApplied(next);
    setLoading(true);
    setError(null);
    fetchOrdersApi(
      { ...next, page: targetPage },
      (rows, totalCount) => {
        setOrders(rows);
        setTotal(totalCount);
        setError(null);
        setPage(targetPage);
      },
      (message) => setError(message),
      () => setLoading(false)
    );
  };

  useEffect(() => {
    let cancelled = false;
    fetchOrdersApi(
      { status: '', q: '' },
      (rows, totalCount) => {
        if (!cancelled) {
          setOrders(rows);
          setTotal(totalCount);
        }
      },
      (message) => {
        if (!cancelled) setError(message);
      },
      () => {
        if (!cancelled) setLoading(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const reloadCurrent = useCallback(() => {
    applyFilters(applied, page);
  }, [applied, page]);

  const openDetails = async (id: string) => {
    setError(null);
    setDetailsBusy(true);
    try {
      setDetails(await fetchOrderDetailsApi(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setDetailsBusy(false);
    }
  };

  const changeStatus = async (id: string, newStatus: string) => {
    if (
      newStatus === 'cancelled' &&
      !window.confirm('Скасувати замовлення? Сток буде повернено на склад.')
    ) {
      return;
    }
    setError(null);
    setDetailsBusy(true);
    try {
      const res = await fetch(`/api/admin/orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Не вдалося змінити статус');

      reloadCurrent();
      setDetails(await fetchOrderDetailsApi(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setDetailsBusy(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold tracking-tight text-gray-900">Замовлення</h1>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-4 mb-4 flex flex-wrap gap-3 items-center">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters(
              { status: statusFilter, q: qInput.trim() },
              1
            );
          }}
          className="flex flex-wrap gap-3 items-center"
        >
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
            }}
            aria-label="Фільтр за статусом"
            className="input sm:w-auto"
          >
            <option value="">Усі статуси</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Номер замовлення або email…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="input w-full sm:w-56"
          />
          <button type="submit" className="btn btn-primary">
            Застосувати
          </button>
        </form>
        <span className="text-sm text-gray-500 ml-auto">
          Знайдено: {total}
          {page > 1 && ` · стор. ${page}`}
        </span>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <div className="bg-white shadow-md rounded-lg overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Номер</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Дата</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Клієнт</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Сума</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Статус</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Дії</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {orders.map((order) => (
              <tr key={order.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-sm">{order.order_number}</td>
                <td className="px-4 py-3 text-sm whitespace-nowrap">{formatDate(order.created_at)}</td>
                <td className="px-4 py-3 text-sm">
                  {order.customer_info?.name || '—'}
                  <span className="block text-xs text-gray-400">{order.email}</span>
                </td>
                <td className="px-4 py-3 text-sm whitespace-nowrap">
                  {order.total_amount} {order.currency}
                </td>
                <td className="px-4 py-3">
                  <OrderStatusBadge status={order.status} />
                  <span className="mt-1 block">
                    <PaymentStatusBadge status={order.payment_status} />
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-sm font-medium whitespace-nowrap">
                  <button
                    onClick={() => openDetails(order.id)}
                    className="text-blue-600 hover:text-blue-900 mr-3"
                  >
                    Детали
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {orders.length === 0 && !loading && (
          <div className="text-center py-12">
            <p className="text-gray-500">Замовлення не знайдено</p>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="bg-white rounded-lg shadow p-4 mt-4 flex items-center justify-between">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => applyFilters(applied, page - 1)}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ← Назад
          </button>
          <span className="text-sm text-gray-600">
            Сторінка {page} з {Math.max(1, Math.ceil(total / PAGE_SIZE))}
            <span className="text-gray-400"> · всего {total}</span>
          </span>
          <button
            type="button"
            disabled={page >= Math.ceil(total / PAGE_SIZE) || loading}
            onClick={() => applyFilters(applied, page + 1)}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Далі →
          </button>
        </div>
      )}

      {/* Details modal */}
      {details && (
        <Modal
          title={
            <span className="font-mono">{details.order.order_number}</span>
          }
          onClose={() => setDetails(null)}
          wide
        >

              <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                <div>
                  <p className="text-gray-500">Статус</p>
                  <OrderStatusBadge status={details.order.status} />
                </div>
                <div>
                  <p className="text-gray-500">Оплата</p>
                  <PaymentStatusBadge status={details.order.payment_status} />
                </div>
                <div>
                  <p className="text-gray-500">Email клієнта</p>
                  <p>{details.order.email}</p>
                </div>
                <div>
                  <p className="text-gray-500">Ім’я / телефон</p>
                  <p>
                    {details.order.customer_info?.name || '—'}
                    {details.order.customer_info?.phone
                      ? ` · ${details.order.customer_info.phone}`
                      : ''}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className="text-gray-500">Доставка</p>
                  <p>
                    {details.order.shipping_info &&
                    Object.keys(details.order.shipping_info).length > 0
                      ? Object.entries(details.order.shipping_info)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(', ')
                      : '—'}
                  </p>
                </div>
              </div>

              <table className="w-full text-sm mb-4">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase border-b">
                    <th className="py-2">Товар</th>
                    <th className="py-2 text-right">К-сть</th>
                    <th className="py-2 text-right">Ціна</th>
                    <th className="py-2 text-right">Сума</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {details.items.map((item, idx) => (
                    <tr key={idx}>
                      <td className="py-2">
                        {item.product_name}
                        {item.variant_name && (
                          <span className="text-gray-500"> · {item.variant_name}</span>
                        )}
                        <span className="block text-xs text-gray-400">SKU: {item.sku}</span>
                      </td>
                      <td className="py-2 text-right">{item.quantity}</td>
                      <td className="py-2 text-right">{item.price}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {item.total} {details.order.currency}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <dl className="space-y-1 text-sm border-t pt-3 mb-4">
                <div className="flex justify-between text-gray-600">
                  <dt>Товари</dt>
                  <dd>{details.order.subtotal} {details.order.currency}</dd>
                </div>
                <div className="flex justify-between text-gray-600">
                  <dt>Доставка</dt>
                  <dd>{details.order.shipping_total} {details.order.currency}</dd>
                </div>
                <div className="flex justify-between font-bold text-base">
                  <dt>Разом</dt>
                  <dd>{details.order.total_amount} {details.order.currency}</dd>
                </div>
              </dl>

              {/* Status actions — allowed transitions only */}
              <div className="border-t pt-4">
                <h3 className="text-sm font-semibold mb-2">Змінити статус</h3>
                <div className="flex flex-wrap gap-2">
                  {(ALLOWED_TRANSITIONS[details.order.status] ?? []).map((next) => (
                    <button
                      key={next}
                      type="button"
                      disabled={detailsBusy}
                      onClick={() => changeStatus(details.order.id, next)}
                      className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                    >
                      → {next}
                    </button>
                  ))}
                  {['pending', 'confirmed'].includes(details.order.status) &&
                    details.order.payment_status !== 'paid' && (
                      <button
                        type="button"
                        disabled={detailsBusy}
                        onClick={() => changeStatus(details.order.id, 'cancelled')}
                        className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700 disabled:opacity-50"
                      >
                        Скасувати (повернути залишок)
                      </button>
                    )}
                  {['pending', 'confirmed'].includes(details.order.status) &&
                    details.order.payment_status === 'paid' && (
                      <span className="px-3 py-1.5 text-sm text-gray-500 border border-gray-200 rounded">
                        Оплата вже отримана — скасування недоступне до повернення коштів
                        (refund)
                      </span>
                    )}
                  {(ALLOWED_TRANSITIONS[details.order.status]?.length ?? 0) === 0 &&
                    !['pending', 'confirmed'].includes(details.order.status) && (
                      <span className="text-sm text-gray-400">
                        Кінцевий статус — переходів немає
                      </span>
                    )}
                </div>
              </div>
      </Modal>
      )}

      <p className="mt-4 text-sm">
        <Link href="/admin" className="text-blue-600 hover:underline">
          ← К дашборду
        </Link>
      </p>
    </div>
  );
}
