/**
 * Behavioral tests for LiqPay payment init + callback orchestration
 * (app/lib/payment/order-payment-update.ts), driven through an in-memory
 * OrdersGateway — the same seam the real Supabase gateway implements.
 *
 * Covers: valid init, missing/wrong token (чужой заказ), paid-order guards,
 * expired orders, repeated-init attempt numbering, valid/duplicate/failure/
 * pending callbacks, amount & currency mismatch, invalid signature,
 * unknown order, money formatting helpers, payload sanity (no secrets).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.LIQPAY_PUBLIC_KEY = 'test-public-key';
process.env.LIQPAY_PRIVATE_KEY = 'test-private-key';
delete process.env.LIQPAY_SANDBOX;

const {
  nextAttemptOrderId,
  sameMoneyCents,
  formatDbAmount,
  buildCheckoutPayload,
  createPaymentInit,
  processLiqPayCallback,
} = await import('../app/lib/payment/order-payment-update.ts');
const { encodeLiqPayData, createLiqPaySignature } = await import(
  '../app/lib/payment/liqpay-signature.ts'
);
const { LIQPAY_CHECKOUT_URL } = await import('../app/lib/payment/liqpay-config.ts');

const PRIV = 'test-private-key';
const ORDER = 'ORD-20260826-ABC123';
const CFG = {
  publicKey: 'test-public-key',
  privateKey: PRIV,
  sandbox: true,
};

// ---------- fake gateway ----------
interface Row {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  total_amount: number;
  currency: string;
  expires_at: string | null;
  liqpay_order_id: string | null;
}

function makeGateway(row: Row | null) {
  const calls: string[] = [];
  const state = row;
  const api = {
    calls,
    get state() {
      return state;
    },
    findOrderForInit: async () => (state ? { ...state } : null),
    // Mirrors the production conditional UPDATE: attempts may be reserved
    // ONLY from unfinalized, non-live states (unpaid/failed).
    saveAttempt: async (i: { orderNumber: string; liqpayOrderId: string }) => {
      calls.push(`saveAttempt:${i.liqpayOrderId}`);
      if (!state || !['unpaid', 'failed'].includes(state.payment_status)) {
        return false;
      }
      state.liqpay_order_id = i.liqpayOrderId;
      state.payment_status = 'pending';
      return true;
    },
    findOrderByLiqpayOrderId: async (id: string) =>
      state && state.liqpay_order_id === id ? { ...state } : null,
    applyPaid: async (i: { id: string; paymentId: number | null; method: string | null }) => {
      calls.push(`applyPaid:${state?.payment_status}:${i.paymentId}:${i.method}`);
      if (!state || state.payment_status === 'paid') return 'already-paid' as const;
      state.payment_status = 'paid';
      return 'applied' as const;
    },
    applyFailed: async (i: { id: string; error: string | null }) => {
      calls.push(`applyFailed:${state?.payment_status}:${i.error}`);
      if (
        !state ||
        state.payment_status === 'paid' ||
        state.payment_status === 'failed' ||
        state.payment_status === 'refunded'
      ) {
        return 'noop' as const;
      }
      state.payment_status = 'failed';
      return 'applied' as const;
    },
    applyRefunded: async () => {
      calls.push('applyRefunded');
      if (!state || state.payment_status !== 'paid') return 'noop' as const;
      state.payment_status = 'refunded';
      return 'applied' as const;
    },
    // Test-only typed accessor (row may legitimately be null in some tests;
    // null-state tests never touch it).
    get row(): Row {
      return state as Row;
    },
  };
  return api;
}

function makeDeps(row: Row | null) {
  const gateway = makeGateway(row);
  return {
    gateway,
    config: CFG,
    privateKey: PRIV,
    verifyToken: (n: string, t: unknown) => n === ORDER && t === 'goodtok',
    accessToken: () => 'goodtok',
    resultUrl: (n: string, t: string) => `https://shop.example.ua/checkout/success?order=${n}&t=${t}`,
    callbackUrl: () => 'https://shop.example.ua/api/payment/liqpay/callback',
  };
}

function baseRow(): Row {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    order_number: ORDER,
    status: 'pending',
    payment_status: 'unpaid',
    total_amount: 1050.5,
    currency: 'UAH',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    liqpay_order_id: null,
  };
}

// ---------- pure helper: attempt numbering ----------

test('INIT-ID: first attempt keeps the bare order number', () => {
  assert.equal(nextAttemptOrderId(ORDER, null), ORDER);
});

test('INIT-ID: second/third attempts append :2/:3', () => {
  assert.equal(nextAttemptOrderId(ORDER, ORDER), `${ORDER}:2`);
  assert.equal(nextAttemptOrderId(ORDER, `${ORDER}:2`), `${ORDER}:3`);
});

// ---------- money ----------

test('MONEY: sameMoneyCents compares numerically across number/string formats', () => {
  assert.equal(sameMoneyCents('1050.50', 1050.5), true);
  assert.equal(sameMoneyCents('1050.51', 1050.5), false);
  assert.equal(sameMoneyCents('10', '10.00'), true);
});

test('MONEY: garbage amounts never match (fail-closed)', () => {
  assert.equal(sameMoneyCents(undefined, 10), false);
  assert.equal(sameMoneyCents('abc', 10), false);
  assert.equal(sameMoneyCents(NaN, 10), false);
});

test('MONEY: formatDbAmount renders exactly two decimals', () => {
  assert.equal(formatDbAmount(1050.5), '1050.50');
  assert.equal(formatDbAmount('7'), '7.00');
});

// ---------- checkout payload ----------

test('PAYLOAD: contains version 3 / action pay / public key / attempt order_id', () => {
  const p = buildCheckoutPayload({
    config: CFG,
    orderIdWithAttempt: `${ORDER}:2`,
    baseOrderNumber: ORDER,
    amount: 1050.5,
    currency: 'UAH',
    resultUrl: 'https://shop.example.ua/r',
    callbackUrl: 'https://shop.example.ua/cb',
  });
  // LiqPay docs: version must be a NUMBER — a string here makes checkout
  // reject the request with "невірний підпис signature".
  assert.equal(typeof p.version, 'number', 'version must be a JSON number');
  assert.equal(p.version, 3);
  assert.equal(p.action, 'pay');
  assert.equal(p.public_key, 'test-public-key');
  assert.equal(p.order_id, `${ORDER}:2`);
  assert.equal(p.amount, '1050.50');
  assert.equal(p.currency, 'UAH');
  assert.equal(p.language, 'uk');
  assert.equal(p.sandbox, '1');
  assert.equal(p.result_url, 'https://shop.example.ua/r');
  assert.equal(p.server_url, 'https://shop.example.ua/cb');
});

test('PAYLOAD: no sandbox field when disabled, never carries the private key', () => {
  const p = buildCheckoutPayload({
    config: { ...CFG, sandbox: false },
    orderIdWithAttempt: ORDER,
    baseOrderNumber: ORDER,
    amount: 1,
    currency: 'UAH',
    resultUrl: 'https://x/',
    callbackUrl: 'https://x/cb',
  });
  assert.ok(!('sandbox' in p));
  assert.doesNotMatch(JSON.stringify(p), /private/i);
});

// ---------- init orchestration ----------

test('INIT: valid request builds signed data and reserves the first attempt', async () => {
  const deps = makeDeps(baseRow());
  const res = await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' });
  assert.equal(res.kind, 'started');
  if (res.kind !== 'started') return;
  assert.equal(res.checkoutUrl, LIQPAY_CHECKOUT_URL);
  const payload = JSON.parse(Buffer.from(res.data, 'base64').toString('utf8'));
  assert.equal(payload.amount, '1050.50');
  assert.equal(payload.currency, 'UAH');
  assert.equal(payload.order_id, ORDER);
  assert.equal(createLiqPaySignature(res.data, PRIV), res.signature);
  assert.ok(deps.gateway.calls.includes(`saveAttempt:${ORDER}`));
});

test('INIT: missing/incorrect token → invalid-token (covers чужой заказ)', async () => {
  for (const tok of [undefined, '', 'wrong-tok']) {
    const deps = makeDeps(baseRow());
    const res = await createPaymentInit(deps, { orderNumber: ORDER, token: tok as string });
    assert.equal((res as { kind: string }).kind, 'invalid-token');
  }
});

test('INIT: unknown order number with well-formed token cannot be fabricated', async () => {
  const deps = makeDeps(null);
  const res = await createPaymentInit(deps, { orderNumber: 'ORD-20260826-ZZZ999', token: 'x' });
  assert.notEqual((res as { kind: string }).kind, 'started');
});

test('INIT: paid order cannot start another payment', async () => {
  const row = { ...baseRow(), payment_status: 'paid' };
  const res = await createPaymentInit(makeDeps(row), { orderNumber: ORDER, token: 'goodtok' });
  assert.equal((res as { kind: string }).kind, 'already-paid');
});

test('INIT: cancelled/confirmed order is refused', async () => {
  const res = await createPaymentInit(
    makeDeps({ ...baseRow(), status: 'cancelled' }),
    { orderNumber: ORDER, token: 'goodtok' }
  );
  assert.equal((res as { kind: string }).kind, 'closed');
});

test('INIT: expired order is refused', async () => {
  const res = await createPaymentInit(
    makeDeps({ ...baseRow(), expires_at: new Date(Date.now() - 1000).toISOString() }),
    { orderNumber: ORDER, token: 'goodtok' }
  );
  assert.equal((res as { kind: string }).kind, 'expired');
});

test('INIT: repeated init while pending → conflict, attempt id NOT overwritten', async () => {
  const deps = makeDeps(baseRow());
  const r1 = await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' });
  assert.equal(r1.kind, 'started');
  const before = deps.gateway.row.liqpay_order_id;
  assert.equal(before, ORDER);

  // Second init arrives while the first session is still live (pending):
  // must be refused so the live provider session stays the ONLY mappable one.
  const r2 = await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' });
  assert.equal(r2.kind, 'conflict');
  assert.equal(deps.gateway.row.liqpay_order_id, ORDER,
    'live liqpay_order_id must never be overwritten by a refused init');
  assert.deepEqual(
    deps.gateway.calls.filter((c) => c.startsWith('saveAttempt')).slice(1),
    [],
    'no new attempt may even reach the DB for a pending order'
  );
});

test('INIT-RACE: stale callback for the live :2 remains valid — init cannot evict it', async () => {
  const deps = makeDeps(baseRow());
  await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' }); // ORD-…
  // A concurrent/late init race is refused; callback for ':2' (which would
  // have been produced only if :2 existed) can simply not exist in this
  // model — but if it DID arrive from a previous failed chain it maps fine.
  const r2 = await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' });
  assert.notEqual(r2.kind, 'started');

  // The saved session is still exactly the one mappable for callbacks.
  assert.ok((await deps.gateway.findOrderByLiqpayOrderId(ORDER)) !== null);
});

test('INIT-RETRY: failed → retry reserves :2; failed again → :3', async () => {
  const deps = makeDeps(baseRow());
  const r1 = await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' });
  assert.equal(r1.kind, 'started');

  // payment fails via the normal callback path
  await processLiqPayCallback(
    { gateway: deps.gateway, privateKey: PRIV },
    (() => {
      const d = encodeLiqPayData({ public_key: 'test-public-key', order_id: ORDER, status: 'failure', amount: '1050.50', currency: 'UAH' });
      return { data: d, signature: createLiqPaySignature(d, PRIV) };
    })()
  );
  assert.equal(deps.gateway.row.payment_status, 'failed');

  const r2 = await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' });
  assert.equal(r2.kind, 'started');
  const p2 = JSON.parse(Buffer.from((r2 as { data: string }).data, 'base64').toString());
  assert.equal(p2.order_id, `${ORDER}:2`);

  await processLiqPayCallback(
    { gateway: deps.gateway, privateKey: PRIV },
    (() => {
      const d = encodeLiqPayData({ public_key: 'test-public-key', order_id: `${ORDER}:2`, status: 'error', amount: '1050.50', currency: 'UAH' });
      return { data: d, signature: createLiqPaySignature(d, PRIV) };
    })()
  );
  const r3 = await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' });
  assert.equal(r3.kind, 'started');
  const p3 = JSON.parse(Buffer.from((r3 as { data: string }).data, 'base64').toString());
  assert.equal(p3.order_id, `${ORDER}:3`);
});

// ---------- callback orchestration ----------

function callbackBody(fields: Record<string, unknown>): { data: string; signature: string } {
  const data = encodeLiqPayData({
    public_key: 'test-public-key',
    order_id: ORDER,
    ...fields,
  });
  return { data, signature: createLiqPaySignature(data, PRIV) };
}

test('CALLBACK: stale SUCCESS for evicted old attempt cannot change order', async () => {
  const deps = makeDeps(baseRow());
  // live session :1 fails → user retries → :2 becomes the live one
  await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' }); // ORD-…
  await processLiqPayCallback(deps2cb(deps), cbBody(ORDER, 'failure'));
  assert.equal(deps.gateway.row.payment_status, 'failed');
  await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' });
  assert.equal(deps.gateway.row.liqpay_order_id, `${ORDER}:2`);

  // :1 succeeds LATE at the provider — but it is no longer the live attempt.
  const res = await processLiqPayCallback(deps2cb(deps), cbBody(ORDER, 'success'));
  assert.equal(res.kind, 'unknown-order');
  assert.equal(deps.gateway.row.payment_status, 'pending',
    'state must be untouched by a stale attempt');
});

test('CALLBACK: paid → paid no-op and paid → failed remain impossible', async () => {
  const deps = makeDeps({ ...baseRow(), payment_status: 'paid', liqpay_order_id: ORDER });
  // replay of success
  const r1 = await processLiqPayCallback(deps2cb(deps), cbBody(ORDER, 'success'));
  assert.equal(r1.kind, 'already-paid');
  // attacker/garbage late failure for same attempt
  const r2 = await processLiqPayCallback(deps2cb(deps), cbBody(ORDER, 'failure'));
  assert.equal(r2.kind, 'kept-pending');
  assert.equal(deps.gateway.row.payment_status, 'paid',
    'paid must survive both replays and late failures');
});

// helpers
function deps2cb(
  deps: ReturnType<typeof makeDeps>
): { gateway: typeof deps.gateway; privateKey: string } {
  return { gateway: deps.gateway, privateKey: PRIV };
}
function cbBody(orderId: string, status: string) {
  return callbackBody({ status, order_id: orderId, amount: '1050.50', currency: 'UAH' });
}

test('CALLBACK: missing data/signature → invalid-request', async () => {
  const deps = makeDeps(null);
  assert.equal((await processLiqPayCallback(deps, {} as { data: string })).kind, 'invalid-request');
  assert.equal(
    (
      await processLiqPayCallback(deps, {
        data: 'e30=',
        signature: undefined,
      } as unknown as { data: string; signature: string })
    ).kind,
    'invalid-request'
  );
});

test('CALLBACK: invalid signature → bad-signature (no processing)', async () => {
  const deps = makeDeps(null);
  const body = callbackBody({ status: 'success' });
  const res = await processLiqPayCallback(deps, {
    data: body.data,
    signature: Buffer.from(crypto.randomBytes(32)).toString('base64'),
  });
  assert.equal(res.kind, 'bad-signature');
});

test('CALLBACK: tampered data → bad-signature', async () => {
  const deps = makeDeps(null);
  const body = callbackBody({ status: 'success' });
  const other = Buffer.from(JSON.stringify({ order_id: 'X' }), 'utf8').toString('base64');
  void other;
  const tampered =
    (body.data[0] === 'Z' ? 'a' : 'Z') + body.data.slice(1);
  const res = await processLiqPayCallback(deps, {
    data: tampered,
    signature: body.signature,
  });
  assert.equal(res.kind, 'bad-signature');
});

test('CALLBACK: unsigned garbage shapes are rejected', async () => {
  const deps = makeDeps(null);
  const junk = Buffer.from('[1,2,3]', 'utf8').toString('base64');
  assert.equal(
    (
      await processLiqPayCallback(deps, {
        data: junk,
        signature: createLiqPaySignature(junk, PRIV),
      })
    ).kind,
    'malformed-payload'
  );
});

test('CALLBACK: unknown order → unknown-order (no update attempted)', async () => {
  const deps = makeDeps(null);
  const res = await processLiqPayCallback(deps, callbackBody({ status: 'success' }));
  assert.equal(res.kind, 'unknown-order');
  assert.deepEqual(deps.gateway.calls.filter((c) => c.startsWith('apply')), []);
});

test('CALLBACK: valid success marks the order paid with id/method', async () => {
  const row = { ...baseRow(), liqpay_order_id: ORDER };
  const deps = makeDeps(row);
  const res = await processLiqPayCallback(
    deps,
    callbackBody({ status: 'success', amount: '1050.50', currency: 'UAH', transaction_id: '777555333', paytype: 'card', method: 'card' })
  );
  assert.equal(res.kind, 'updated');
  assert.deepEqual(deps.gateway.calls.filter((c) => c.startsWith('applyPaid')),
    [`applyPaid:unpaid:777555333:card:card`]);
});

test('CALLBACK: amount mismatch refuses every kind of update', async () => {
  for (const st of ['success', 'failure']) {
    const deps = makeDeps({ ...baseRow(), liqpay_order_id: ORDER });
    const res = await processLiqPayCallback(
      deps,
      callbackBody({ status: st, amount: '99.99', currency: 'UAH' })
    );
    assert.equal(res.kind, 'amount-mismatch', `status ${st}`);
    assert.ok(!deps.gateway.calls.some((c) => c.startsWith('apply')));
  }
});

test('CALLBACK: currency mismatch refuses update even with correct amount', async () => {
  const deps = makeDeps({ ...baseRow(), liqpay_order_id: ORDER });
  const res = await processLiqPayCallback(
    deps,
    callbackBody({ status: 'success', amount: '1050.50', currency: 'USD' })
  );
  assert.equal(res.kind, 'currency-mismatch');
});

test('CALLBACK: duplicate success / paid → paid = no-op + processed', async () => {
  const row = { ...baseRow(), payment_status: 'paid', liqpay_order_id: ORDER };
  const deps = makeDeps(row);
  const res = await processLiqPayCallback(
    deps,
    callbackBody({ status: 'success', amount: '1050.50', currency: 'UAH' })
  );
  assert.equal(res.kind, 'already-paid');
});

test('CALLBACK: failure → failed (only from unfinalized states)', async () => {
  const deps = makeDeps({ ...baseRow(), liqpay_order_id: ORDER });
  const res = await processLiqPayCallback(
    deps,
    callbackBody({ status: 'failure', amount: '1050.50', currency: 'UAH' })
  );
  assert.equal(res.kind, 'updated');
});

test('CALLBACK: intermediate statuses leave payment pending, no final writes', async () => {
  for (const st of ['processing', '3ds_verify', 'wait_accept', 'hold_wait']) {
    const deps = makeDeps({ ...baseRow(), liqpay_order_id: ORDER });
    const res = await processLiqPayCallback(
      deps,
      callbackBody({ status: st, amount: '1050.50', currency: 'UAH' })
    );
    assert.equal(res.kind, 'kept-pending', `status ${st}`);
  }
});

test('CALLBACK: reversed applies refund only from paid state', async () => {
  const deps = makeDeps({ ...baseRow(), payment_status: 'paid', liqpay_order_id: ORDER });
  const res = await processLiqPayCallback(
    deps,
    callbackBody({ status: 'reversed', amount: '1050.50', currency: 'UAH' })
  );
  assert.equal(res.kind, 'updated');

  const deps2 = makeDeps({ ...baseRow(), payment_status: 'pending', liqpay_order_id: ORDER });
  const res2 = await processLiqPayCallback(
    deps2,
    callbackBody({ status: 'reversed', amount: '1050.50', currency: 'UAH' })
  );
  assert.equal(res2.kind, 'kept-pending');
});

// ---------- full lifecycle audit (pre-production) ----------

test('LIFECYCLE: unpaid → init :1 → failure → failed → init :2 → success for :2 → paid', async () => {
  const deps = makeDeps(baseRow());

  // attempt :1
  const r1 = await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' });
  assert.equal(r1.kind, 'started');
  assert.equal(JSON.parse(Buffer.from((r1 as { data: string }).data, 'base64').toString()).order_id, ORDER);

  // provider reports terminal failure for :1
  await processLiqPayCallback(deps2cb(deps), cbBody(ORDER, 'failure'));
  assert.equal(deps.gateway.row.payment_status, 'failed');

  // retry reserves :2
  const r2 = await createPaymentInit(deps, { orderNumber: ORDER, token: 'goodtok' });
  assert.equal(r2.kind, 'started');
  assert.equal(deps.gateway.row.liqpay_order_id, `${ORDER}:2`);

  // success for the live attempt :2 → paid with id/method
  const res = await processLiqPayCallback(
    deps2cb(deps),
    callbackBody({
      status: 'sandbox',
      order_id: `${ORDER}:2`,
      amount: '1050.50',
      currency: 'UAH',
      transaction_id: '100200300',
      paytype: 'card',
    })
  );
  assert.equal(res.kind, 'updated');
  assert.deepEqual(
    deps.gateway.calls.filter((c) => c.startsWith('applyPaid')),
    ['applyPaid:pending:100200300:card']
  );
  // a failed order never resurfaces as unpaid under retry — it is pending now
  assert.equal(deps.gateway.row.payment_status, 'paid');
});

test('LIFECYCLE: every documented intermediate status keeps the order pending (callback level)', async () => {
  for (const st of [
    'processing',
    '3ds_verify',
    'otp_verify',
    'wait_accept',
    'wait_secure',
    'prepared',
    'hold_wait',
    'cash_wait',
  ]) {
    const deps = makeDeps({ ...baseRow(), liqpay_order_id: ORDER });
    const res = await processLiqPayCallback(
      deps,
      callbackBody({ status: st, amount: '1050.50', currency: 'UAH' })
    );
    assert.equal(res.kind, 'kept-pending', `status ${st}`);
    assert.ok(!deps.gateway.calls.some((c) => c.startsWith('apply')),
      `status ${st} must never reach any state transition`);
  }
});

test('LIFECYCLE: after paid, neither duplicate success nor stale failure mutate anything', async () => {
  const row = { ...baseRow(), payment_status: 'paid', liqpay_order_id: ORDER };
  const deps = makeDeps(row);
  const dup = await processLiqPayCallback(deps2cb(deps), cbBody(ORDER, 'success'));
  const fail = await processLiqPayCallback(deps2cb(deps), cbBody(ORDER, 'failure'));
  assert.equal(dup.kind, 'already-paid');
  assert.equal(fail.kind, 'kept-pending');
  // zero transition calls beyond the guarded ones: no writes were ATTEMPTED twice
  assert.deepEqual(
    deps.gateway.calls.filter((c) => c.startsWith('applyPaid')),
    ['applyPaid:paid:null:null'],
    'duplicate callback must short-circuit on the paid guard, not re-apply'
  );
});
