import { LIQPAY_CHECKOUT_URL, type LiqPayConfig } from './liqpay-config.ts';
import {
  createLiqPaySignature,
  encodeLiqPayData,
  verifyLiqPaySignature,
  decodeLiqPayData,
} from './liqpay-signature.ts';
import { mapLiqPayStatus, type PaymentStatus } from './liqpay-status.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Payment-state transitions for LiqPay against the existing order model.
 *
 * Design notes:
 *  - All orchestration is expressed over the OrdersGateway seam so it is
 *    unit-testable without network; the route handlers bind this module to
 *    a real Supabase service-role client (thin adapters only).
 *  - Money NEVER comes from the client: init reads total_amount/currency
 *    from the orders row; callbacks are verified against the DB row.
 *  - `paid` is terminal: both init and callbacks guard against it and the
 *    underlying UPDATE statements are conditional (…neq('payment_status','paid'))
 *    so concurrent callback/init races cannot regress a paid order.
 */

// ---------------------------------------------------------------------------
// Gateway seam
// ---------------------------------------------------------------------------

export interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  total_amount: number | string;
  currency: string;
  expires_at: string | null;
  liqpay_order_id: string | null;
}

export interface CallbackOrderRow {
  id: string;
  order_number: string;
  payment_status: string;
  total_amount: number | string;
  currency: string;
}

export type ApplyResult = 'applied' | 'already-paid' | 'noop';

export interface OrdersGateway {
  findOrderForInit(orderNumber: string): Promise<OrderRow | null>;
  /** Conditional attempt reservation; false when guarded away (e.g. paid). */
  saveAttempt(input: { orderNumber: string; liqpayOrderId: string }): Promise<boolean>;
  findOrderByLiqpayOrderId(liqpayOrderId: string): Promise<CallbackOrderRow | null>;
  applyPaid(input: {
    id: string;
    paymentId: number | null;
    method: string | null;
  }): Promise<ApplyResult>;
  applyFailed(input: { id: string; error: string | null }): Promise<ApplyResult>;
  /** Refund semantics exist in the model; only meaningful from paid state. */
  applyRefunded(input: { id: string }): Promise<ApplyResult>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** ORD-… → first attempt; with current attempt → next :N suffix. */
export function nextAttemptOrderId(
  orderNumber: string,
  currentLiqpayOrderId: string | null
): string {
  if (!currentLiqpayOrderId) return orderNumber;
  const m = currentLiqpayOrderId.match(/^(.*):(\d+)$/);
  if (!m || m[1] !== orderNumber) return `${orderNumber}:2`;
  return `${orderNumber}:${Number(m[2]) + 1}`;
}

function toCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Numeric cents comparison tolerant of "1050.50" vs 1050.5 formats. */
export function sameMoneyCents(a: unknown, b: unknown): boolean {
  const ca = toCents(a);
  const cb = toCents(b);
  if (ca === null || cb === null) return false;
  return Math.abs(ca - cb) < 1e-6;
}

export function formatDbAmount(amount: number | string): string {
  return toCents(amount)! === null
    ? '0.00'
    : (toCents(amount)! / 100).toFixed(2);
}

export interface CheckoutPayloadInput {
  config: Pick<LiqPayConfig, 'publicKey' | 'sandbox'>;
  orderIdWithAttempt: string;
  baseOrderNumber: string;
  amount: number | string;
  currency: string;
  resultUrl: string;
  callbackUrl: string;
}

export function buildCheckoutPayload(i: CheckoutPayloadInput): Record<string, string | number> {
  const payload: Record<string, string | number> = {
    public_key: i.config.publicKey,
    // LiqPay API contract: version is a Number (docs example: "version":7).
    // A string here makes checkout reject with "невірний підпис signature".
    version: 3,
    action: 'pay',
    amount: formatDbAmount(i.amount),
    currency: i.currency,
    description: `Оплата замовлення ${i.baseOrderNumber}`,
    order_id: i.orderIdWithAttempt,
    language: 'uk',
    result_url: i.resultUrl,
    server_url: i.callbackUrl,
  };
  if (i.config.sandbox) payload.sandbox = '1';
  return payload;
}

// ---------------------------------------------------------------------------
// Init orchestration
// ---------------------------------------------------------------------------

export interface InitDeps {
  gateway: OrdersGateway;
  config: LiqPayConfig;
  verifyToken(orderNumber: string, token: unknown): boolean;
  accessToken(orderNumber: string): string;
  resultUrl(orderNumber: string, token: string): string;
  callbackUrl(): string;
}

export type InitOutcome =
  | { kind: 'invalid-token' }
  | { kind: 'not-found' }
  | { kind: 'already-paid' }
  | { kind: 'closed' }
  | { kind: 'expired' }
  | { kind: 'conflict' }
  | { kind: 'not-configured' }
  | {
      kind: 'started';
      data: string;
      signature: string;
      checkoutUrl: string;
      liqpayOrderId: string;
    };

export async function createPaymentInit(
  deps: InitDeps,
  input: { orderNumber: string; token: unknown }
): Promise<InitOutcome> {
  if (
    typeof input.orderNumber !== 'string' ||
    input.orderNumber.length > 40 ||
    !deps.verifyToken(input.orderNumber, input.token)
  ) {
    return { kind: 'invalid-token' };
  }

  const order = await deps.gateway.findOrderForInit(input.orderNumber);
  if (!order) return { kind: 'not-found' };
  if (order.payment_status === 'paid') return { kind: 'already-paid' };
  // A pending order has a LIVE provider session bound to liqpay_order_id.
  // Creating another attempt now would evict it and orphan in-flight
  // payments (late success callback for the evicted id could never map).
  // Retries are allowed ONLY after a terminal failure.
  if (order.payment_status === 'pending') return { kind: 'conflict' };
  if (order.status !== 'pending') return { kind: 'closed' };
  if (order.expires_at && new Date(order.expires_at).getTime() < Date.now()) {
    return { kind: 'expired' };
  }

  let liqpayOrderId: string;
  try {
    liqpayOrderId = nextAttemptOrderId(order.order_number, order.liqpay_order_id);
  } catch {
    return { kind: 'conflict' };
  }
  const reserved = await deps.gateway.saveAttempt({
    orderNumber: order.order_number,
    liqpayOrderId,
  });
  if (!reserved) return { kind: 'conflict' };

  const payload = buildCheckoutPayload({
    config: deps.config,
    orderIdWithAttempt: liqpayOrderId,
    baseOrderNumber: order.order_number,
    amount: order.total_amount,
    currency: order.currency,
    resultUrl: deps.resultUrl(
      order.order_number,
      deps.accessToken(order.order_number)
    ),
    callbackUrl: deps.callbackUrl(),
  });
  const data = encodeLiqPayData(payload);
  const signature = createLiqPaySignature(data, deps.config.privateKey);

  return {
    kind: 'started',
    data,
    signature,
    checkoutUrl: LIQPAY_CHECKOUT_URL,
    liqpayOrderId,
  };
}

// ---------------------------------------------------------------------------
// Callback orchestration
// ---------------------------------------------------------------------------

export interface CallbackDeps {
  gateway: OrdersGateway;
  privateKey: string;
}

export type CallbackOutcome =
  | { kind: 'invalid-request'; log: string }
  | { kind: 'bad-signature'; log: string }
  | { kind: 'malformed-payload'; log: string }
  | { kind: 'unknown-order'; log: string }
  | { kind: 'amount-mismatch'; log: string }
  | { kind: 'currency-mismatch'; log: string }
  | { kind: 'already-paid'; log?: string }
  | { kind: 'updated'; status: PaymentStatus }
  | { kind: 'kept-pending' };

const ORDER_ID_RE = /^[A-Za-z0-9:-]{1,100}$/;

function methodOf(payload: Record<string, unknown>): string | null {
  const parts = [payload.method, payload.paytype]
    .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 40);
  return parts.length > 0 ? parts.join(':') : null;
}

function paymentIdOf(payload: Record<string, unknown>): number | null {
  const raw = payload.transaction_id ?? payload.payment_id;
  if ((typeof raw !== 'string' && typeof raw !== 'number') || !/^\d+$/.test(String(raw))) {
    return null;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function errorOf(payload: Record<string, unknown>): string | null {
  const parts = [payload.err_code, payload.err_description]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => v.slice(0, 100));
  return parts.length > 0 ? parts.join(': ').slice(0, 200) : null;
}

export async function processLiqPayCallback(
  deps: CallbackDeps,
  body: { data?: unknown; signature?: unknown }
): Promise<CallbackOutcome> {
  const { data, signature } = body;

  // 1–2. presence + signature — before any decode or DB access.
  if (typeof data !== 'string' || data === '' ||
      typeof signature !== 'string' || signature === '') {
    return { kind: 'invalid-request', log: 'callback missing data/signature' };
  }
  if (!verifyLiqPaySignature(data, signature, deps.privateKey)) {
    return { kind: 'bad-signature', log: 'callback signature mismatch' };
  }

  // 3–4. decode + structural validation.
  const payload = decodeLiqPayData(data);
  if (!payload || typeof payload.order_id !== 'string') {
    return { kind: 'malformed-payload', log: 'callback payload not an object / no order_id' };
  }
  if (!ORDER_ID_RE.test(payload.order_id)) {
    return { kind: 'malformed-payload', log: 'callback order_id malformed' };
  }

  const mapped = mapLiqPayStatus(payload.status);

  // 5. find the order by its per-attempt LiqPay id.
  const order = await deps.gateway.findOrderByLiqpayOrderId(payload.order_id);
  if (!order) {
    return { kind: 'unknown-order', log: `no order for liqpay_order_id ${payload.order_id}` };
  }

  // 6–7. money verification against the DB row; missing/garbage amounts on
  // terminal claims fail closed.
  if (mapped !== 'pending' && toCents(payload.amount) === null) {
    return {
      kind: 'amount-mismatch',
      log: `callback for ${payload.order_id}: amount missing/garbage`,
    };
  }
  if (!sameMoneyCents(payload.amount ?? null, order.total_amount)) {
    return {
      kind: 'amount-mismatch',
      log: `callback amount mismatch for ${payload.order_id}`,
    };
  }
  if (
    typeof payload.currency === 'string'
      ? payload.currency.toUpperCase() !== String(order.currency).toUpperCase()
      : mapped !== 'pending'
  ) {
    return { kind: 'currency-mismatch', log: `callback currency mismatch for ${payload.order_id}` };
  }

  // 9. conditional, idempotent updates.
  switch (mapped) {
    case 'paid': {
      const res = await deps.gateway.applyPaid({
        id: order.id,
        paymentId: paymentIdOf(payload),
        method: methodOf(payload),
      });
      return res === 'applied'
        ? { kind: 'updated', status: 'paid' }
        : { kind: 'already-paid' };
    }
    case 'failed': {
      const res = await deps.gateway.applyFailed({ id: order.id, error: errorOf(payload) });
      return res === 'applied' ? { kind: 'updated', status: 'failed' } : { kind: 'kept-pending' };
    }
    case 'refunded': {
      const res = await deps.gateway.applyRefunded({ id: order.id });
      return res === 'applied' ? { kind: 'updated', status: 'refunded' } : { kind: 'kept-pending' };
    }
    default:
      return { kind: 'kept-pending' };
  }
}

function updatedCount(res: { data: unknown[] | null }): boolean {
  return Array.isArray(res.data) && res.data.length > 0;
}

type OrdersFrom = ReturnType<SupabaseClient['from']>;

/**
 * Production OrdersGateway over a service-role Supabase client.
 * Every transition is a single conditional UPDATE so concurrent callbacks
 * and init calls cannot double-apply or regress terminal states
 * (PostgreSQL re-evaluates the quals after waiting on the row lock).
 */
export function createSupabaseOrdersGateway(db: SupabaseClient): OrdersGateway {
  const from = (): OrdersFrom => db.from('orders');
  return {
    async findOrderForInit(orderNumber) {
      const res = await from()
        .select(
          'id, order_number, status, payment_status, total_amount, currency, expires_at, liqpay_order_id'
        )
        .eq('order_number', orderNumber)
        .maybeSingle();
      return (res.data ?? null) as OrderRow | null;
    },

    async saveAttempt({ orderNumber, liqpayOrderId }) {
      // Conditional reservation: attempts may be created ONLY from
      // unfinalized, non-live states. This is the authoritative race guard
      // (concurrent inits both pass the orchestration check, but only one
      // conditional UPDATE wins; the loser must not evict the live session).
      const res = await from()
        .update({ liqpay_order_id: liqpayOrderId, payment_status: 'pending' })
        .eq('order_number', orderNumber)
        .in('payment_status', ['unpaid', 'failed'])
        .select('id');
      return updatedCount(res as unknown as { data: unknown[] | null });
    },

    async findOrderByLiqpayOrderId(liqpayOrderId) {
      const res = await from()
        .select('id, order_number, payment_status, total_amount, currency')
        .eq('liqpay_order_id', liqpayOrderId)
        .maybeSingle();
      return (res.data ?? null) as CallbackOrderRow | null;
    },

    async applyPaid({ id, paymentId, method }) {
      const res = await from()
        .update({
          payment_status: 'paid',
          paid_at: new Date().toISOString(),
          liqpay_payment_id: paymentId,
          payment_method: method,
          payment_error: null,
        })
        .eq('id', id)
        .neq('payment_status', 'paid')
        // B1 interlock: a success callback that was blocked on the row lock
        // while expire_pending_orders()/admin_cancel_order() committed
        // status='cancelled' must never flip that order to paid (PostgreSQL
        // re-evaluates quals after the lock wait, so this qualifier sees the
        // committed cancel).
        .neq('status', 'cancelled')
        .select('id');
      return updatedCount(res as unknown as { data: unknown[] | null })
        ? 'applied'
        : 'already-paid';
    },

    async applyFailed({ id, error }) {
      const res = await from()
        .update({ payment_status: 'failed', payment_error: error })
        .eq('id', id)
        .in('payment_status', ['unpaid', 'pending'])
        .select('id');
      return updatedCount(res as unknown as { data: unknown[] | null })
        ? 'applied'
        : 'noop';
    },

    async applyRefunded({ id }) {
      const res = await from()
        .update({ payment_status: 'refunded' })
        .eq('id', id)
        .eq('payment_status', 'paid')
        .select('id');
      return updatedCount(res as unknown as { data: unknown[] | null })
        ? 'applied'
        : 'noop';
    },
  };
}
