const STYLES: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  confirmed: 'bg-blue-100 text-blue-800',
  shipped: 'bg-indigo-100 text-indigo-800',
  delivered: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-800',
  returned: 'bg-gray-200 text-gray-700',
};

const LABELS: Record<string, string> = {
  pending: 'Очікує підтвердження',
  confirmed: 'Підтверджено',
  shipped: 'Відправлено',
  delivered: 'Доставлено',
  cancelled: 'Скасовано',
  returned: 'Повернуто',
};

/** Colored order-status chip with a human-readable Ukrainian label. */
export default function OrderStatusBadge({ status }: { status: string }) {
  const style = STYLES[status] ?? 'bg-gray-100 text-gray-700';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${style}`}
    >
      {LABELS[status] ?? status}
    </span>
  );
}

export function PaymentStatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    paid: ['Оплачено', 'bg-green-100 text-green-800'],
    unpaid: ['Не оплачено', 'bg-gray-100 text-gray-600'],
    pending: ['Очікує оплату', 'bg-yellow-100 text-yellow-800'],
    failed: ['Помилка оплати', 'bg-red-100 text-red-700'],
    refunded: ['Повернено', 'bg-indigo-100 text-indigo-800'],
  };
  const [label, style] = map[status] ?? [status, 'bg-gray-100 text-gray-600'];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}
    >
      {label}
    </span>
  );
}
