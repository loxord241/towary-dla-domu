'use client';

import { useState } from 'react';

/**
 * READ-ONLY LiqPay ↔ DB reconciliation view for admins.
 * The backend endpoint is GET-only; this page offers no mutating controls
 * (retries/payments) by design — remediation is an out-of-band decision.
 */

interface ReconciliationItem {
  order_number: string;
  created_at: string;
  status: string;
  payment_status: string;
  amount: number | string;
  currency: string;
  liqpay_order_id: string | null;
  liqpay_payment_id: number | string | null;
  paid_at: string | null;
  payment_method: string | null;
  provider_status: string | null;
  classification: string;
}

interface ReconciliationReport {
  generated_at: string;
  checked: number;
  summary: Record<string, number>;
  findings: ReconciliationItem[];
  duplicate_payment_ids: Array<{ liqpay_payment_id: number; order_numbers: string[] }>;
}

const ALL_CLASSES = [
  'OK_OK',
  'PROVIDER_SUCCESS_DB_NOT_PAID',
  'DB_PAID_PROVIDER_NOT_SUCCESS',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'PAID_MISSING_PAYMENT_ID',
  'STALE_ATTEMPT',
  'PROVIDER_NOT_FOUND',
  'UNREACHABLE',
] as const;

const CLASS_LABELS: Record<string, string> = {
  OK_OK: 'Узгоджено (OK_OK)',
  PROVIDER_SUCCESS_DB_NOT_PAID: 'Провайдер: успіх, БД не paid',
  DB_PAID_PROVIDER_NOT_SUCCESS: 'БД paid, провайдер не success',
  AMOUNT_MISMATCH: 'Розбіжність суми',
  CURRENCY_MISMATCH: 'Розбіжність валюти',
  PAID_MISSING_PAYMENT_ID: 'paid без liqpay_payment_id',
  STALE_ATTEMPT: 'Протухла спроба оплати',
  PROVIDER_NOT_FOUND: 'Не знайдена у провайдера',
  UNREACHABLE: 'Status API недоступний',
};

// Money/status contradictions and duplicates are the highest-severity
// classes — they always deserve immediate manual attention.
const CRITICAL_CLASSES = new Set([
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'DUPLICATE_PAYMENT_ID',
  'PROVIDER_SUCCESS_DB_NOT_PAID',
  'DB_PAID_PROVIDER_NOT_SUCCESS',
]);

const WARNING_CLASSES = new Set(['PAID_MISSING_PAYMENT_ID', 'STALE_ATTEMPT']);

// Exactly the fact — never an overclaim about whether money moved elsewhere.
const NOT_FOUND_NOTE =
  'Транзакція не знайдена в поточному merchant/key context LiqPay. Це лише констатація стану поточного контексту, а не висновок про долю платежу.';

function classTone(cls: string): string {
  if (CRITICAL_CLASSES.has(cls)) return 'bg-red-100 text-red-800 border-red-300';
  if (WARNING_CLASSES.has(cls)) return 'bg-amber-100 text-amber-800 border-amber-300';
  if (cls === 'UNREACHABLE') return 'bg-gray-100 text-gray-700 border-gray-300';
  // PROVIDER_NOT_FOUND etc.: informational blue tone.
  return 'bg-blue-50 text-blue-800 border-blue-200';
}

async function fetchReconciliationApi(
  days: number,
  limit: number,
  onData: (report: ReconciliationReport) => void,
  onError: (message: string) => void,
  onDone: () => void
) {
  try {
    const res = await fetch(
      `/api/admin/orders/reconciliation?days=${days}&limit=${limit}`
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Помилка запиту до reconciliation API');
    onData(data as ReconciliationReport);
  } catch (err) {
    onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

export default function OrdersReconciliationAdminPage() {
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  const runCheck = async () => {
    setError(null);
    setLoading(true);
    await fetchReconciliationApi(days, 100, setReport, setError, () =>
      setLoading(false)
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">
          Зверка платежів LiqPay ↔ БД (read-only)
        </h1>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="border rounded px-2 py-1 text-sm"
          aria-label="Вікно перевірки"
        >
          <option value={7}>7 днів</option>
          <option value={30}>30 днів</option>
          <option value={90}>90 днів</option>
        </select>
        <button
          onClick={() => void runCheck()}
          disabled={loading}
          className="bg-slate-800 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {loading ? 'Перевірка…' : 'Перевірити'}
        </button>
        {report && (
          <span className="text-xs text-gray-500">
            Остання перевірка: {new Date(report.generated_at).toLocaleString('uk-UA')} ·
            перевірено замовлень: {report.checked}
          </span>
        )}
      </div>

      <p className="text-sm text-gray-500">
        Інструмент тільки читає дані замовлень і Status API LiqPay (action=status).
        Автоматичних виправлень немає: усі розбіжності потребують ручного рішення.
      </p>

      {error && (
        <div className="bg-red-50 border border-red-300 text-red-800 rounded p-3 text-sm">
          {error}
        </div>
      )}

      {report && (
        <>
          {/* Summary buckets — every classification is rendered distinctly. */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
            {ALL_CLASSES.map((cls) => {
              const count = report.summary[cls] ?? 0;
              return (
                <div
                  key={cls}
                  className={`border rounded p-2 ${classTone(cls)} ${
                    count === 0 && cls !== 'OK_OK' ? 'opacity-40' : ''
                  }`}
                >
                  <div className="text-lg font-semibold">{count}</div>
                  <div className="text-xs">{CLASS_LABELS[cls]}</div>
                </div>
              );
            })}
            {(report.duplicate_payment_ids?.length ?? 0) > 0 && (
              <div className="border rounded p-2 bg-red-100 text-red-800 border-red-300">
                <div className="text-lg font-semibold">
                  {report.duplicate_payment_ids.length}
                </div>
                <div className="text-xs">Дублікати payment_id</div>
              </div>
            )}
          </div>

          {/* Critical findings table */}
          {report.findings.length > 0 ? (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="py-2 px-2">Замовлення</th>
                  <th className="py-2 px-2">Клас</th>
                  <th className="py-2 px-2">DB</th>
                  <th className="py-2 px-2">Provider</th>
                  <th className="py-2 px-2">Сума</th>
                  <th className="py-2 px-2">payment_id</th>
                </tr>
              </thead>
              <tbody>
                {[...report.findings]
                  .sort((a, b) =>
                    Number(CRITICAL_CLASSES.has(b.classification)) -
                    Number(CRITICAL_CLASSES.has(a.classification))
                  )
                  .map((f) => (
                    <tr key={f.order_number} className="border-t">
                      <td className="py-2 px-2 font-mono">{f.order_number}</td>
                      <td className="py-2 px-2">
                        <span
                          className={`inline-block rounded border px-2 py-0.5 text-xs ${classTone(f.classification)}`}
                        >
                          {CLASS_LABELS[f.classification] ?? f.classification}
                        </span>
                        {f.classification === 'PROVIDER_NOT_FOUND' && (
                          <div className="mt-1 max-w-[280px] text-xs text-blue-700">
                            {NOT_FOUND_NOTE}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-2">{f.payment_status}</td>
                      <td className="py-2 px-2">{f.provider_status ?? '(n/a)'}</td>
                      <td className="py-2 px-2 whitespace-nowrap">
                        {String(f.amount)} {f.currency}
                      </td>
                      <td className="py-2 px-2 font-mono">
                        {f.liqpay_payment_id ?? '(null)'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            report.checked > 0 && (
              <div className="bg-green-50 border border-green-200 text-green-800 rounded p-3 text-sm">
                Усі перевірені платежі узгоджені (OK_OK).
              </div>
            )
          )}

          {(report.duplicate_payment_ids?.length ?? 0) > 0 && (
            <div className="bg-red-50 border border-red-300 text-red-800 rounded p-3 text-sm space-y-1">
              <div className="font-semibold">Дублікати payment_id:</div>
              {report.duplicate_payment_ids.map((d) => (
                <div key={d.liqpay_payment_id} className="font-mono">
                  {d.liqpay_payment_id}: {d.order_numbers.join(', ')}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
