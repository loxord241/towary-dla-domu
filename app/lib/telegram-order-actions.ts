import crypto from 'node:crypto';

/**
 * Telegram order-action webhook (owner feature 2026-09-13: обработка заказа
 * в один тап из уведомления).
 *
 * Pure decision logic — no I/O here. The route handler:
 *  1. verifies the secret header,
 *  2. parses the update,
 *  3. calls these helpers against the DB and Telegram API,
 *  4. ALWAYS answers 200 (Telegram retries non-2xx; a failed action is
 *     reported to the chat instead).
 *
 * Secret model: the webhook secret is DERIVED from the existing bot token
 * (HMAC-SHA256(token, 'tg-webhook:v1')) — the same value is registered via
 * setWebhook, so no second env var exists to configure or leak. Telegram
 * sends it back verbatim in X-Telegram-Bot-Api-Secret-Token on every call.
 */

const SECRET_INFO = 'tg-webhook:v1';

/** Same derivation the setWebhook registration uses. */
export function webhookSecret(botToken: string): string {
  return crypto.createHmac('sha256', botToken).update(SECRET_INFO).digest('hex');
}

/** Timing-safe header check; false on any malformed input. */
export function isAuthorizedRequest(headerValue: unknown, botToken: unknown): boolean {
  if (typeof headerValue !== 'string' || typeof botToken !== 'string') return false;
  if (headerValue === '' || botToken === '') return false;
  const expected = Buffer.from(webhookSecret(botToken), 'utf8');
  const provided = Buffer.from(headerValue, 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

export type OrderAction = 'confirm' | 'cancel' | 'paid';

/** `ord:<orderNumber>:<action>` — order numbers are [A-Z0-9-] only. */
export function parseCallbackData(
  data: unknown
): { orderNumber: string; action: OrderAction } | null {
  if (typeof data !== 'string') return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== 'ord') return null;
  const orderNumber = parts[1]!;
  const action = parts[2]!;
  if (!/^[A-Za-z0-9-]+$/.test(orderNumber)) return null;
  if (action !== 'confirm' && action !== 'cancel' && action !== 'paid') return null;
  return { orderNumber, action };
}

/** Minimal shape of a Telegram update carrying a callback query. */
export interface CallbackUpdate {
  id: string;
  orderNumber: string;
  action: OrderAction;
  chatId: number;
  messageId: number;
}

export function parseUpdate(update: unknown): CallbackUpdate | null {
  if (typeof update !== 'object' || update === null) return null;
  const cq = (update as { callback_query?: unknown }).callback_query;
  if (typeof cq !== 'object' || cq === null) return null;
  const c = cq as Record<string, unknown>;
  const parsed = parseCallbackData(c.data);
  if (!parsed) return null;
  const id = typeof c.id === 'string' ? c.id : null;
  const message = c.message as Record<string, unknown> | undefined;
  const chat = message?.chat as Record<string, unknown> | undefined;
  const chatId = typeof chat?.id === 'number' ? chat.id : null;
  const messageId = typeof message?.message_id === 'number' ? message.message_id : null;
  if (id === null || chatId === null || messageId === null) return null;
  return { id, orderNumber: parsed.orderNumber, action: parsed.action, chatId, messageId };
}

/** Result of applying an action — drives both the toast and the message edit. */
export type ApplyOutcome =
  | { kind: 'ok'; flash: string; statusLine: string }
  | { kind: 'noop'; flash: string }
  | { kind: 'error'; flash: string };

export interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  payment_method: string | null;
}

export interface OrderActionsGateway {
  order(orderNumber: string): Promise<OrderRow | null>;
  confirm(orderId: string): Promise<'ok' | 'conflict'>;
  cancel(orderId: string): Promise<'ok' | 'conflict'>;
  markPaid(orderId: string): Promise<'ok' | 'already-paid'>;
}

/**
 * Applies the action through the SAME guarded RPCs the admin UI uses
 * (forward-only transitions, atomic cancel with stock restore, conditional
 * paid). Any unexpected state is a noop/error — the webhook never throws.
 */
export async function applyAction(
  action: OrderAction,
  row: OrderRow,
  gw: OrderActionsGateway
): Promise<ApplyOutcome> {
  if (row.status === 'cancelled') {
    return { kind: 'noop', flash: 'Замовлення вже скасоване' };
  }
  if (action === 'confirm') {
    if (row.status !== 'pending') {
      return { kind: 'noop', flash: `Замовлення вже в статусі ${row.status}` };
    }
    const r = await gw.confirm(row.id);
    return r === 'ok'
      ? { kind: 'ok', flash: 'Підтверджено ✅', statusLine: '✅ Підтверджено' }
      : { kind: 'error', flash: 'Конфлікт статусу — відкрийте адмінку' };
  }
  if (action === 'cancel') {
    if (row.status !== 'pending' && row.status !== 'confirmed') {
      return { kind: 'noop', flash: `Скасувати можна лише до відправки (зараз ${row.status})` };
    }
    const r = await gw.cancel(row.id);
    return r === 'ok'
      ? { kind: 'ok', flash: 'Скасовано, товар повернуто на склад', statusLine: '❌ Скасовано' }
      : { kind: 'error', flash: 'Конфлікт статусу — відкрийте адмінку' };
  }
  // paid: mark paid + confirm a still-pending order in one tap.
  if (row.payment_status === 'paid') {
    return { kind: 'noop', flash: 'Оплату вже позначено' };
  }
  const r = await gw.markPaid(row.id);
  if (r !== 'ok') {
    return { kind: 'noop', flash: 'Оплату вже позначено' };
  }
  if (row.status === 'pending') {
    await gw.confirm(row.id);
    return {
      kind: 'ok',
      flash: 'Оплачено ✅ (замовлення підтверджено)',
      statusLine: '💰 Оплачено · ✅ Підтверджено',
    };
  }
  return { kind: 'ok', flash: 'Оплачено ✅', statusLine: '💰 Оплачено' };
}

/** Message text with the status line appended (idempotent-ish: replaces an
    earlier status line instead of stacking). */
export function withStatusLine(originalText: string, statusLine: string): string {
  const cleaned = originalText.replace(/\n—{5,}[\s\S]*$/, '');
  return `${cleaned}\n—————————\n${statusLine}`;
}
