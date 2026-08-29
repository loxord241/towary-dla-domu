/**
 * Telegram order notifications — SERVER-ONLY side effect for new orders.
 *
 * Architecture contract (feature: Telegram-уведомлення про нові замовлення):
 *  - called ONLY after place_order() has committed the order (route handler
 *    schedules it via next/server `after`, i.e. after the 201 response);
 *  - a Telegram failure NEVER affects the order, the checkout response,
 *    payment status or any DB row — every error path resolves, never throws;
 *  - credentials live exclusively in server-side env:
 *      TELEGRAM_BOT_TOKEN, TELEGRAM_ORDER_CHAT_ID (both required to enable);
 *    the token is never logged, never put in the request body and never
 *    leaves the server (the bot token is part of the endpoint URL only);
 *  - plain-text messages (no parse_mode) — user-controlled text cannot
 *    break any formatting, so no escaping is required by design;
 *  - at-most-once per created order: exactly one HTTP call, no retry loop
 *    (a checkout retry creates a NEW order number, so per-order duplicates
 *    cannot originate from this module).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { formatPrice } from '../format.ts';

export interface OrderNotificationItem {
  name: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  price: number;
  total: number;
}

export interface OrderNotificationData {
  orderId: string;
  orderNumber: string;
  total: number;
  currency: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string;
  paymentMethod: string | null;
  delivery: Record<string, unknown> | null;
  items: OrderNotificationItem[];
}

export type TelegramSendFailureReason =
  | 'disabled'
  | 'db_read_failed'
  | 'http_error'
  | 'telegram_error'
  | 'bad_response'
  | 'network_error'
  | 'unexpected';

export interface TelegramSendResult {
  sent: boolean;
  reason?: TelegramSendFailureReason;
  detail?: string; // safe: status codes / error names only, never secrets or payloads
}

export interface TelegramOrderConfig {
  enabled: boolean;
  token?: string;
  chatId?: string;
}

/**
 * Both env vars required; any missing/pairing combination → disabled.
 * Never returns the values themselves to callers that only need the flag.
 */
export function resolveTelegramOrderConfig(): TelegramOrderConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ORDER_CHAT_ID?.trim();
  if (!token || !chatId) return { enabled: false };
  return { enabled: true, token, chatId };
}

const SERVICE_LABELS: Record<string, string> = {
  nova_poshta_warehouse: 'Нова Пошта — відділення',
  nova_poshta_locker: 'Нова Пошта — поштомат',
  nova_poshta_courier: 'Нова Пошта — кур’єр',
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Human-readable delivery line from shipping_info.delivery (or null). */
export function describeDelivery(delivery: Record<string, unknown> | null): string {
  if (!delivery) return 'не вказано';
  const parts: string[] = [];
  const serviceType = asString(delivery.serviceType);
  parts.push(SERVICE_LABELS[serviceType] ?? 'Нова Пошта');
  const settlement = asString(delivery.settlementName);
  if (settlement) parts.push(settlement);
  const division = asString(delivery.divisionName);
  if (division) parts.push(division);
  const street = asString(delivery.streetName);
  if (street) {
    const building = asString(delivery.building);
    const flat = asString(delivery.flat);
    let address = street;
    if (building) address += `, ${building}`;
    if (flat) address += `, кв. ${flat}`;
    parts.push(address);
  }
  return parts.join(', ');
}

const ITEM_NAME_MAX = 160;
const MESSAGE_MAX = 4000; // Telegram hard limit is 4096; keep headroom

/**
 * Plain-text message (no parse_mode): user-controlled names cannot inject
 * or break Markdown/HTML — nothing is parsed on Telegram's side.
 */
export function buildOrderNotificationMessage(
  data: OrderNotificationData,
  adminBaseUrl?: string
): string {
  const lines: string[] = [];
  lines.push('🛒 НОВЕ ЗАМОВЛЕННЯ');
  lines.push('');
  lines.push(`№: ${data.orderNumber}`);
  lines.push(`Сума: ${formatPrice(data.total, data.currency)}`);
  lines.push(
    `Оплата: ${data.paymentMethod ? data.paymentMethod : 'не вибрано (після оформлення)'}`
  );
  lines.push(`Доставка: ${describeDelivery(data.delivery)}`);
  lines.push('');
  lines.push('Клієнт:');
  if (data.customerName) lines.push(data.customerName.slice(0, ITEM_NAME_MAX));
  if (data.customerPhone) lines.push(data.customerPhone);
  lines.push(data.customerEmail);
  lines.push('');
  lines.push('Товари:');
  for (const item of data.items) {
    const name = [item.name, item.variantName]
      .filter((part): part is string => !!part)
      .join(' — ')
      .slice(0, ITEM_NAME_MAX);
    const sku = item.sku ? ` (${item.sku})` : '';
    lines.push(`• ${name}${sku} × ${item.quantity} — ${formatPrice(item.total, data.currency)}`);
  }
  lines.push('');
  lines.push(
    `Разом товарів: ${data.items.reduce((sum, item) => sum + item.quantity, 0)}`
  );
  const base = adminBaseUrl?.trim().replace(/\/+$/, '');
  if (base) {
    lines.push('');
    lines.push(`Адмінка: ${base}/admin/orders/${data.orderId}`);
  }
  const message = lines.join('\n');
  return message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX)}…` : message;
}

const TELEGRAM_TIMEOUT_MS = 4000;
const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * One HTTP call, bounded by an AbortController timeout; no retry (the
 * notification is best-effort — a retry would double the latency budget of
 * post-response work for a secondary side effect).
 *
 * Log line contains ONLY the order number + reason/detail (status code or
 * error name) — never the token, the URL, the message text or customer data.
 */
export async function sendTelegramOrderMessage(
  data: OrderNotificationData,
  config: TelegramOrderConfig = resolveTelegramOrderConfig()
): Promise<TelegramSendResult> {
  if (!config.enabled) return { sent: false, reason: 'disabled' };

  const text = buildOrderNotificationMessage(
    data,
    process.env.NEXT_PUBLIC_SITE_URL
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  let result: TelegramSendResult;
  try {
    const response = await fetch(
      `${TELEGRAM_API_BASE}/bot${config.token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Token deliberately NOT in the body — it is part of the endpoint path only.
        body: JSON.stringify({ chat_id: config.chatId, text }),
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      result = { sent: false, reason: 'http_error', detail: `HTTP ${response.status}` };
    } else {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { ok?: unknown }).ok === true
      ) {
        result = { sent: true };
      } else if (typeof payload === 'object' && payload !== null) {
        const errorCode = (payload as { error_code?: unknown }).error_code;
        result = {
          sent: false,
          reason: 'telegram_error',
          detail: `ok:false${typeof errorCode === 'number' ? ` code=${errorCode}` : ''}`,
        };
      } else {
        result = { sent: false, reason: 'bad_response', detail: 'non-JSON body' };
      }
    }
  } catch (error) {
    result = {
      sent: false,
      reason: 'network_error',
      detail: error instanceof Error ? error.name : 'unknown',
    };
  } finally {
    clearTimeout(timer);
  }
  if (!result.sent) {
    console.error(
      `telegram notification failed for order ${data.orderNumber}: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`
    );
  }
  return result;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asStringOrNull(value: unknown): string | null {
  const str = asString(value);
  return str === '' ? null : str;
}

/**
 * Read-back of the just-committed order via service-role client (RLS bypass
 * is required: orders/order_items have no public SELECT). SELECT-only.
 */
export async function loadOrderNotificationData(
  client: SupabaseClient,
  orderNumber: string
): Promise<OrderNotificationData | null> {
  const { data: order, error } = await client
    .from('orders')
    .select(
      'id, order_number, total_amount, currency, email, customer_info, shipping_info, payment_method'
    )
    .eq('order_number', orderNumber)
    .maybeSingle();
  if (error || !order) return null;

  const { data: rows } = await client
    .from('order_items')
    .select('product_name, variant_name, sku, quantity, price, total')
    .eq('order_id', order.id);

  const customerInfo =
    typeof order.customer_info === 'object' && order.customer_info !== null
      ? (order.customer_info as Record<string, unknown>)
      : {};
  const shippingInfo =
    typeof order.shipping_info === 'object' && order.shipping_info !== null
      ? (order.shipping_info as Record<string, unknown>)
      : {};
  const delivery =
    typeof shippingInfo.delivery === 'object' && shippingInfo.delivery !== null
      ? (shippingInfo.delivery as Record<string, unknown>)
      : null;

  return {
    orderId: String(order.id),
    orderNumber: String(order.order_number),
    total: asNumber(order.total_amount),
    currency: asString(order.currency) || 'UAH',
    customerName: asString(customerInfo.name),
    customerPhone: asStringOrNull(customerInfo.phone),
    customerEmail: asString(order.email),
    paymentMethod: asStringOrNull(order.payment_method),
    delivery,
    items: (rows ?? []).map((row) => ({
      name: asString(row.product_name),
      variantName: asStringOrNull(row.variant_name),
      sku: asStringOrNull(row.sku),
      quantity: asNumber(row.quantity),
      price: asNumber(row.price),
      total: asNumber(row.total),
    })),
  };
}

/**
 * Production entry point used by the checkout route. Never throws — any
 * failure resolves as { sent: false } and is logged without secrets.
 */
export async function sendTelegramOrderNotification(
  orderNumber: string
): Promise<TelegramSendResult> {
  try {
    const config = resolveTelegramOrderConfig();
    if (!config.enabled) return { sent: false, reason: 'disabled' };

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      console.error(
        `telegram notification failed for order ${orderNumber}: db_read_failed (service client unavailable)`
      );
      return { sent: false, reason: 'db_read_failed' };
    }
    const client = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });
    const data = await loadOrderNotificationData(client, orderNumber);
    if (!data) {
      console.error(
        `telegram notification failed for order ${orderNumber}: db_read_failed (order not found)`
      );
      return { sent: false, reason: 'db_read_failed' };
    }
    return await sendTelegramOrderMessage(data, config);
  } catch (error) {
    console.error(
      `telegram notification failed for order ${orderNumber}: unexpected ${error instanceof Error ? error.name : 'error'}`
    );
    return { sent: false, reason: 'unexpected' };
  }
}
