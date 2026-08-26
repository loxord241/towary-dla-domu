/**
 * Audit tests for the PRODUCTION OrdersGateway adapter
 * (createSupabaseOrdersGateway) — the layer where race-safety actually lives.
 *
 * The orchestration tests (tests/payment-routes.test.ts) run against an
 * in-memory gateway; these lock the real conditional-UPDATE qualifiers of the
 * Supabase adapter so a regression in any guard fails loudly:
 *   saveAttempt     … in(payment_status, [unpaid, failed])   ← attempt race
 *   applyPaid       … neq(payment_status, 'paid')           ← paid terminality
 *   applyFailed     … in(payment_status, [unpaid, pending])
 *   applyRefunded   … eq(payment_status, 'paid')            ← refund origin
 *
 * Driven through a minimal fluent mock capturing method arguments verbatim;
 * no network, no DB credentials.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only-key';

const { createSupabaseOrdersGateway } = await import(
  '../app/lib/payment/order-payment-update.ts'
);

interface Call {
  op: 'select' | 'update' | 'eq' | 'in' | 'neq';
  args: unknown[];
}

class FakeBuilder {
  calls: Call[] = [];
  private resolvedRows: Record<string, unknown>[] = [];
  static lastCreated: FakeBuilder | null = null;

  constructor(rows: Record<string, unknown>[]) {
    this.resolvedRows = rows;
    FakeBuilder.lastCreated = this;
  }
  select(cols: string): FakeBuilder {
    // select() may open a chain OR finalize an UPDATE returning rows; both recorded
    if (!this.calls.some((c) => c.op === 'select')) {
      this.calls.push({ op: 'select', args: [cols] });
    } else {
      this.calls.push({ op: 'select-return', args: [cols] } as never);
    }
    return this;
  }
  update(patch: Record<string, unknown>): FakeBuilder {
    this.calls.push({ op: 'update', args: [patch] });
    return this;
  }
  eq(col: string, val: unknown): FakeBuilder {
    this.calls.push({ op: 'eq', args: [col, val] });
    return this;
  }
  in(col: string, vals: unknown[]): FakeBuilder {
    this.calls.push({ op: 'in', args: [col, vals] });
    return this;
  }
  neq(col: string, val: unknown): FakeBuilder {
    this.calls.push({ op: 'neq', args: [col, val] });
    return this;
  }
  maybeSingle(): Promise<{ data: Record<string, unknown> | null }> {
    return Promise.resolve({ data: this.resolvedRows[0] ?? null });
  }
  // `.select('id')` chain is directly awaited by the adapter
  then<T>(
    onFul: (v: { data: Record<string, unknown>[] | null }) => T,
    onRej?: (e: unknown) => T
  ): Promise<T> {
    return Promise.resolve({ data: this.resolvedRows }).then(onFul, onRej);
  }
}

function fakeDb(rows: Record<string, unknown>[] | null) {
  const tableFrom: string[] = [];
  return {
    from(table: string) {
      tableFrom.push(table);
      return new FakeBuilder((rows ?? []) as Record<string, unknown>[]);
    },
    tables: tableFrom,
  };
}

test('ADAPTER: findOrderForInit reads only public.order_number match via maybeSingle', async () => {
  const db = fakeDb([{ id: 'u1', payment_status: 'unpaid' }]);
  const g = createSupabaseOrdersGateway(db as never);
  const row = await g.findOrderForInit('ORD-X');
  assert.equal(row?.id, 'u1');
  assert.deepEqual(db.tables, ['orders']);
  const b = FakeBuilder.lastCreated!;
  assert.deepEqual(b.calls.filter((c) => c.op === 'eq'), [{ op: 'eq', args: ['order_number', 'ORD-X'] }]);
});

test('ADAPTER: saveAttempt reserves ONLY from unpaid/failed and sets pending atomically', async () => {
  const db = fakeDb([{ id: 'row1' }]);
  const g = createSupabaseOrdersGateway(db as never);
  const ok = await g.saveAttempt({ orderNumber: 'ORD-X', liqpayOrderId: 'ORD-X:2' });
  assert.equal(ok, true);
  const b = FakeBuilder.lastCreated!;
  const upd = b.calls.find((c) => c.op === 'update')!;
  // attempt reservation must set BOTH fields in one atomic statement
  assert.deepEqual(upd.args[0], { liqpay_order_id: 'ORD-X:2', payment_status: 'pending' });
  // THE race guard: pending orders can never be re-reserved
  assert.deepEqual(
    b.calls.filter((c) => c.op === 'in'),
    [{ op: 'in', args: ['payment_status', ['unpaid', 'failed']] }]
  );
  assert.ok(b.calls.some((c) => c.op === 'eq' && c.args[0] === 'order_number'));
});

test('ADAPTER: saveAttempt reports false when zero rows qualify (guarded away)', async () => {
  const db = fakeDb([]); // e.g. current state is pending/paid → UPDATE matches nothing
  const g = createSupabaseOrdersGateway(db as never);
  const ok = await g.saveAttempt({ orderNumber: 'ORD-X', liqpayOrderId: 'ORD-X:2' });
  assert.equal(ok, false, 'losing a reservation race must surface as conflict upstream');
});

test('ADAPTER: applyPaid guarded by neq(paid); writes paid_at/payment_id/method and clears error', async () => {
  const db = fakeDb([{ id: 'row1' }]);
  const g = createSupabaseOrdersGateway(db as never);
  const res = await g.applyPaid({ id: 'row1', paymentId: 777, method: 'card' });
  assert.equal(res, 'applied');
  const b = FakeBuilder.lastCreated!;
  const patch = b.calls.find((c) => c.op === 'update')!.args[0] as Record<string, unknown>;
  assert.equal(patch.payment_status, 'paid');
  assert.equal(typeof patch.paid_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(patch.paid_at as string)), 'paid_at must be a valid timestamp');
  assert.equal(patch.liqpay_payment_id, 777);
  assert.equal(patch.payment_method, 'card');
  assert.equal(patch.payment_error, null);
  assert.ok(
    b.calls.some((c) => c.op === 'neq' && c.args[0] === 'payment_status' && c.args[1] === 'paid'),
    'paid is terminal: concurrent callbacks must lose this UPDATE'
  );
  assert.ok(b.calls.some((c) => c.op === 'eq' && c.args[0] === 'id'));
});

test('ADAPTER: applyPaid guarded ALSO against status=cancelled (B1 interlock)', async () => {
  // Race: expire_pending_orders() holds the row lock, commits status='cancelled',
  // THEN a blocked success callback proceeds. The UPDATE quals must exclude
  // cancelled rows so a cancelled order can never regress into paid.
  const db = fakeDb([{ id: 'row1' }]);
  const g = createSupabaseOrdersGateway(db as never);
  const res = await g.applyPaid({ id: 'row1', paymentId: 777, method: 'card' });
  assert.equal(res, 'applied');
  const b = FakeBuilder.lastCreated!;
  assert.deepEqual(
    b.calls.filter((c) => c.op === 'neq'),
    [
      { op: 'neq', args: ['payment_status', 'paid'] },
      { op: 'neq', args: ['status', 'cancelled'] },
    ],
    'applyPaid must carry BOTH terminality guards: payment neq(paid) AND status neq(cancelled)'
  );
});

test('ADAPTER: applyPaid maps empty update result to already-paid (idempotent replay)', async () => {
  const db = fakeDb([]);
  const g = createSupabaseOrdersGateway(db as never);
  const res = await g.applyPaid({ id: 'row1', paymentId: 777, method: 'card' });
  assert.equal(res, 'already-paid');
});

test('ADAPTER: applyFailed touches only unpaid|pending rows', async () => {
  const db = fakeDb([{ id: 'r' }]);
  const g = createSupabaseOrdersGateway(db as never);
  const res = await g.applyFailed({ id: 'r', error: 'err_code: bad' });
  assert.equal(res, 'applied');
  const b = FakeBuilder.lastCreated!;
  assert.deepEqual(
    b.calls.filter((c) => c.op === 'in'),
    [{ op: 'in', args: ['payment_status', ['unpaid', 'pending']] }],
    'failed/refunded states must never flip to failed'
  );
  const patch = b.calls.find((c) => c.op === 'update')!.args[0] as Record<string, unknown>;
  assert.equal(patch.payment_status, 'failed');
});

test('ADAPTER: refunded originates ONLY from paid', async () => {
  const db = fakeDb([{ id: 'r' }]);
  const g = createSupabaseOrdersGateway(db as never);
  await g.applyRefunded({ id: 'r' });
  const b = FakeBuilder.lastCreated!;
  assert.deepEqual(
    b.calls.filter((c) => c.op === 'eq'),
    [
      { op: 'eq', args: ['id', 'r'] },
      { op: 'eq', args: ['payment_status', 'paid'] },
    ]
  );
});

test('ADAPTER: callback lookup keys strictly on liqpay_order_id', async () => {
  const db = fakeDb(null);
  const g = createSupabaseOrdersGateway(db as never);
  const out = await g.findOrderByLiqpayOrderId('ORD-X:2');
  assert.equal(out, null);
  const b = FakeBuilder.lastCreated!;
  assert.deepEqual(b.calls.filter((c) => c.op === 'eq'), [
    { op: 'eq', args: ['liqpay_order_id', 'ORD-X:2'] },
  ]);
});
