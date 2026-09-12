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
 *  - at-most-once per created order per recipient: exactly one HTTP call
 *    per configured chat id, no retry loop (a checkout retry creates a NEW
 *    order number, so per-order duplicates cannot originate from this
 *    module); TELEGRAM_ORDER_CHAT_ID accepts a comma-separated list.
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
  chatIds: string[];
}

/**
 * TELEGRAM_ORDER_CHAT_ID accepts a comma-separated list of chat ids
 * (e.g. "907687581,-1001234567890") — every recipient gets the message.
 * Whitespace and empty entries are tolerated. Token + at least one
 * recipient required to enable; values are never exposed by the flag check.
 */
export function resolveTelegramOrderConfig(): TelegramOrderConfig {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatIds = (process.env.TELEGRAM_ORDER_CHAT_ID ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (!token || chatIds.length === 0) return { enabled: false, chatIds: [] };
  return { enabled: true, token, chatIds };
}

const SERVICE_LABELS: Record<string, string> = {
  nova_poshta_warehouse: 'Нова Пошта — відділення',
  nova_poshta_locker: 'Нова Пошта — поштомат',
  nova_poshta_courier: 'Нова Пошта — кур’єр',
  ukrposhta_warehouse: 'Укрпошта — відділення',
  pickup: 'Самовивіз',
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Cash-on-pickup intent from shipping_info.delivery (pickup orders only). */
export function deliveryPaymentIntent(
  delivery: Record<string, unknown> | null
): string {
  return asString(delivery?.paymentIntent);
}

/** Human-readable delivery line from shipping_info.delivery (or null). */
export function describeDelivery(delivery: Record<string, unknown> | null): string {
  if (!delivery) return 'не вказано';
  const parts: string[] = [];
  const serviceType = asString(delivery.serviceType);
  // Pickup: the canonical point name already carries «місто, адреса».
  if (serviceType === 'pickup') {
    parts.push(SERVICE_LABELS[serviceType] ?? 'Самовивіз');
    const point = asString(delivery.pickupPointName);
    if (point) {
      parts.push(point);
    } else {
      const settlement = asString(delivery.settlementName);
      if (settlement) parts.push(settlement);
    }
    return parts.join(', ');
  }
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
    `Оплата: ${
      data.paymentMethod
        ? data.paymentMethod
        : deliveryPaymentIntent(data.delivery) === 'cash_on_pickup'
          ? 'готівка при отриманні (на точці самовивоза)'
          : 'не вибрано (після оформлення)'
    }`
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
 * One HTTP call to one recipient, bounded by an AbortController timeout.
 * No retry (the notification is best-effort — a retry would double the
 * latency budget of post-response work for a secondary side effect).
 */
async function postTelegramMessage(
  token: string,
  chatId: string,
  text: string
): Promise<TelegramSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  let result: TelegramSendResult;
  try {
    const response = await fetch(
      `${TELEGRAM_API_BASE}/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Token deliberately NOT in the body — it is part of the endpoint path only.
        body: JSON.stringify({ chat_id: chatId, text }),
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
  return result;
}

/**
 * Sends the same message to EVERY configured recipient. sent=true only when
 * all recipients succeeded; per-recipient failures are logged (recipient
 * index only — never the chat id, token, message text or customer data).
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
  const total = config.chatIds.length;
  let okCount = 0;
  let firstFailure: TelegramSendResult | undefined;
  for (let index = 0; index < total; index++) {
    const result = await postTelegramMessage(
      config.token!,
      config.chatIds[index]!,
      text
    );
    if (result.sent) {
      okCount++;
    } else {
      firstFailure ??= result;
      console.error(
        `telegram notification failed for order ${data.orderNumber} (recipient ${index + 1}/${total}): ${result.reason}${result.detail ? ` (${result.detail})` : ''}`
      );
    }
  }
  if (okCount === total) return { sent: true };
  return {
    sent: false,
    reason: firstFailure?.reason,
    detail: `recipients:${okCount}/${total}`,
  };
}

/**
 * Generic plain-text broadcast over the SAME recipients/token pipeline as
 * order notifications (feature: cron reconciliation alert — the admin chat
 * already receives order notifications, so the same chat is the alert
 * target; no new env vars, no second Telegram implementation).
 *
 * Contract mirrors sendTelegramOrderMessage: never throws, one HTTP call
 * per configured chat id, no retry loop, per-recipient failures are logged
 * (recipient index only — never the chat id, token or message text). The
 * text is fully server-generated (no user-controlled content).
 */
export async function sendTelegramText(
  text: string,
  config: TelegramOrderConfig = resolveTelegramOrderConfig()
): Promise<TelegramSendResult> {
  if (!config.enabled) return { sent: false, reason: 'disabled' };

  const total = config.chatIds.length;
  let okCount = 0;
  let firstFailure: TelegramSendResult | undefined;
  for (let index = 0; index < total; index++) {
    const result = await postTelegramMessage(
      config.token!,
      config.chatIds[index]!,
      text
    );
    if (result.sent) {
      okCount++;
    } else {
      firstFailure ??= result;
      console.error(
        `telegram text notification failed (recipient ${index + 1}/${total}): ${result.reason}${result.detail ? ` (${result.detail})` : ''}`
      );
    }
  }
  if (okCount === total) return { sent: true };
  return {
    sent: false,
    reason: firstFailure?.reason,
    detail: `recipients:${okCount}/${total}`,
  };
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
