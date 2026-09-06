/**
 * Cron reconciliation endpoint — automated "money captured on a cancelled
 * order" detection + Telegram alert (closes the detection gap of the
 * admin-only reconciliation button).
 *
 * Contract under test:
 *   - bearer-token-only auth: Authorization: Bearer ${CRON_SECRET}; missing,
 *     wrong or UNCONFIGURED secret → generic 401 with NO scan executed
 *     (fail-closed); NO admin session/cookie involved (cron has no session);
 *   - a successful scan ALWAYS answers 200 with a readable JSON summary,
 *     even at zero findings;
 *   - Telegram failures never fail the request (never-throws pipeline);
 *   - classification/reuse invariants: the route delegates to
 *     reconciliation-scan → reconciliation.ts; classifier invariants
 *     themselves are pinned in tests/reconciliation.test.ts and are NOT
 *     duplicated here.
 *
 * Route behavior is loaded from the REAL route source with only the
 * untestable edges stubbed (project pattern: next/server and @/ aliases are
 * not resolvable under plain node:test — see rate-limit-xff /
 * novapost-streets-route tests). The scan orchestration itself is tested
 * behaviorally through its dependency seam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = 'app/api/cron/reconciliation/route.ts';
const routeSource = readFileSync(path.join(root, ROUTE), 'utf8');

process.env.CRON_SECRET = 'test-cron-secret';

const {
  runReconciliationScan,
  collectAlerts,
  buildReconciliationAlertMessage,
  ALERT_CLASSES,
} = await import('../app/lib/payment/reconciliation-scan.ts');

// ---------------------------------------------------------------------------
// Fixtures (classification itself is NOT re-tested — see reconciliation.test.ts)
// ---------------------------------------------------------------------------

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    order_number: 'ORD-20260901-AAA111',
    liqpay_order_id: 'ORD-20260901-AAA111',
    liqpay_payment_id: null,
    payment_status: 'pending',
    total_amount: '1050.50',
    currency: 'UAH',
    status: 'pending',
    expires_at: null as string | null,
    created_at: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

function providerSuccess(overrides: Record<string, unknown> = {}) {
  return {
    result: 'ok',
    status: 'success',
    order_id: 'ORD-20260901-AAA111',
    payment_id: 7_777_777,
    amount: 1050.5,
    currency: 'UAH',
    ...overrides,
  };
}

// ---------------- scan module: alert extraction (pure) ----------------

test('CRON-RECON: collectAlerts extracts ONLY the money-hole alert classes', () => {
  const alerts = collectAlerts([
    { classification: 'PROVIDER_SUCCESS_DB_NOT_PAID', order_number: 'ORD-2' },
    { classification: 'CURRENCY_MISMATCH', order_number: 'ORD-3' },
    { classification: 'MANUAL_REVIEW', order_number: 'ORD-4' },
    { classification: 'AMOUNT_MISMATCH', order_number: 'ORD-1' },
    { classification: 'OK_OK', order_number: 'ORD-5' },
    { classification: 'STALE_ATTEMPT', order_number: 'ORD-6' },
  ]);
  assert.deepEqual(
    alerts.map((a) => a.alertClass),
    ['PROVIDER_SUCCESS_DB_NOT_PAID', 'AMOUNT_MISMATCH'],
    'exactly the two money-integrity classes, in ALERT_CLASSES order'
  );
  assert.deepEqual(alerts[0]!.orderNumbers, ['ORD-2']);
  assert.deepEqual(alerts[1]!.orderNumbers, ['ORD-1']);
  assert.ok(ALERT_CLASSES.length === 2);
});

test('CRON-RECON: collectAlerts returns [] for a clean scan', () => {
  assert.deepEqual(collectAlerts([{ classification: 'OK_OK', order_number: 'ORD-1' }]), []);
});

// ---------------- scan module: Telegram message builder (pure) ----------------

test('CRON-RECON: alert message contains class, count, orders and the manual-remediation call-to-action', () => {
  const message = buildReconciliationAlertMessage({
    alertClass: 'PROVIDER_SUCCESS_DB_NOT_PAID',
    orderNumbers: ['ORD-A', 'ORD-B'],
  });
  assert.match(message, /RECONCILIATION: PROVIDER_SUCCESS_DB_NOT_PAID/);
  assert.match(message, /Кількість: 2/);
  assert.match(message, /Закази: ORD-A, ORD-B/);
  assert.match(message, /Ручне втручання: LiqPay дашборд → refund\/рішення/);
  assert.ok(message.length <= 4096, 'must fit Telegram message limit');
});

test('CRON-RECON: alert message shows at most 10 order numbers with a tail counter', () => {
  const orders = Array.from({ length: 12 }, (_, i) => `ORD-${String(i).padStart(2, '0')}`);
  const message = buildReconciliationAlertMessage({
    alertClass: 'AMOUNT_MISMATCH',
    orderNumbers: orders,
  });
  assert.ok(message.includes('ORD-00') && message.includes('ORD-09'));
  assert.ok(!message.includes('ORD-10'), 'only 10 numbers listed');
  assert.match(message, /…та ще 2/);
});

// ---------------- scan orchestration (real code, fake deps) ----------------

test('CRON-RECON: scan with a consistent paid order → 200-style summary, zero findings, no alerts', async () => {
  const rowCalls: Array<{ fromIso: string; limit: number }> = [];
  const providerCalls: string[] = [];
  const result = await runReconciliationScan({
    deps: {
      fetchOrderRows: async (fromIso, limit) => {
        rowCalls.push({ fromIso, limit });
        return [dbRow({ payment_status: 'paid', liqpay_payment_id: 7_777_777 })];
      },
      fetchProvider: async (id) => {
        providerCalls.push(id);
        return providerSuccess();
      },
    },
  });
  assert.equal(result.checked, 1);
  assert.equal(result.summary['OK_OK'], 1);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.alerts, []);
  assert.match(result.windowFrom, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(providerCalls, ['ORD-20260901-AAA111']);
  assert.equal(rowCalls.length, 1);
});

test('CRON-RECON: cancelled order + provider success → PROVIDER_SUCCESS_DB_NOT_PAID alert with the order number', async () => {
  const result = await runReconciliationScan({
    deps: {
      fetchOrderRows: async () => [dbRow({ status: 'cancelled' })],
      fetchProvider: async () => providerSuccess(),
    },
  });
  assert.equal(result.summary['PROVIDER_SUCCESS_DB_NOT_PAID'], 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]!.alertClass, 'PROVIDER_SUCCESS_DB_NOT_PAID');
  assert.deepEqual(result.alerts[0]!.orderNumbers, ['ORD-20260901-AAA111']);
});

test('CRON-RECON: scan failure surfaces as a thrown error (route maps it to 500, never an all-clear)', async () => {
  await assert.rejects(
    runReconciliationScan({
      deps: {
        fetchOrderRows: async () => {
          throw new Error('RECON_SCAN_DB_READ_FAILED: boom');
        },
        fetchProvider: async () => null,
      },
    }),
    /RECON_SCAN_DB_READ_FAILED/
  );
});

// ---------------- route: real source, untestable edges stubbed ----------------

type CronTestGlobal = typeof globalThis & {
  __cronScanCalls?: number;
  __cronScanResult?: unknown;
  __cronScanThrow?: unknown;
  __cronTexts?: string[];
  __cronSendThrow?: unknown;
  __cronSendResult?: unknown;
};
const g = globalThis as CronTestGlobal;

type RouteModule = { GET: (request: Request) => Promise<Response> };

function resetFakes() {
  g.__cronScanCalls = 0;
  g.__cronScanResult = undefined;
  g.__cronScanThrow = undefined;
  g.__cronTexts = [];
  g.__cronSendThrow = undefined;
  g.__cronSendResult = undefined;
}

async function loadRoute(): Promise<RouteModule> {
  const rewritten = routeSource
    .replace(
      /import\s*\{\s*NextResponse\s*\}\s*from\s*'next\/server';/,
      `const NextResponse = { json: (body: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(body), init) };`
    )
    .replace(
      /import\s*\{\s*runReconciliationScan,\s*buildReconciliationAlertMessage,\s*\}\s*from\s*'@\/app\/lib\/payment\/reconciliation-scan';/,
      `const runReconciliationScan = async () => {
        const g = globalThis as CronTestGlobal;
        g.__cronScanCalls = (g.__cronScanCalls ?? 0) + 1;
        if (g.__cronScanThrow) throw g.__cronScanThrow;
        return g.__cronScanResult;
      };
      const buildReconciliationAlertMessage = (alert: { alertClass: string; orderNumbers: string[] }) =>
        'ALERT:' + alert.alertClass + ':' + alert.orderNumbers.join(',');`
    )
    .replace(
      /import\s*\{\s*sendTelegramText\s*\}\s*from\s*'@\/app\/lib\/notifications\/telegram';/,
      `const sendTelegramText = async (text: string) => {
        const g = globalThis as CronTestGlobal;
        (g.__cronTexts = g.__cronTexts ?? []).push(text);
        if (g.__cronSendThrow) throw g.__cronSendThrow;
        return (g.__cronSendResult as { sent: boolean }) ?? { sent: true };
      };`
    );
  const dir = mkdtempSync(path.join(tmpdir(), 'cron-reconciliation-'));
  try {
    const file = path.join(dir, 'route-stubbed.mts');
    writeFileSync(file, rewritten);
    return (await import(pathToFileURL(file).href)) as RouteModule;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const req = (headers: Record<string, string> = {}) =>
  new Request('https://example.com/api/cron/reconciliation', { headers });

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

test('CRON-RECON route: 401 without Authorization header, no scan executed', async () => {
  const { GET } = await loadRoute();
  resetFakes();
  const res = await GET(req());
  assert.equal(res.status, 401);
  assert.equal(g.__cronScanCalls, 0, 'fail-closed: scan must not run');
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, 'Unauthorized');
});

test('CRON-RECON route: 401 with a wrong bearer, no scan executed', async () => {
  const { GET } = await loadRoute();
  resetFakes();
  const res = await GET(req(bearer('wrong-secret')));
  assert.equal(res.status, 401);
  assert.equal(g.__cronScanCalls, 0);
});

test('CRON-RECON route: 401 fail-closed when CRON_SECRET is not configured at all', async () => {
  const { GET } = await loadRoute();
  resetFakes();
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const res = await GET(req(bearer('anything')));
    assert.equal(res.status, 401);
    assert.equal(g.__cronScanCalls, 0);
  } finally {
    process.env.CRON_SECRET = saved;
  }
});

test('CRON-RECON route: 200 with readable summary at zero findings', async () => {
  const { GET } = await loadRoute();
  resetFakes();
  g.__cronScanResult = {
    generatedAt: '2026-09-06T06:00:00.000Z',
    windowFrom: '2026-08-30T06:00:00.000Z',
    checked: 0,
    summary: {},
    findings: [],
    alerts: [],
  };
  const res = await GET(req(bearer('test-cron-secret')));
  assert.equal(res.status, 200);
  assert.equal(g.__cronScanCalls, 1);
  const body = (await res.json()) as {
    generated_at: string;
    checked: number;
    summary: Record<string, number>;
    alerts: unknown[];
    notifications: unknown[];
    readonly: boolean;
  };
  assert.equal(body.checked, 0);
  assert.deepEqual(body.summary, {});
  assert.deepEqual(body.alerts, []);
  assert.deepEqual(body.notifications, []);
  assert.equal(body.readonly, true);
  assert.match(body.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(g.__cronTexts, [], 'no Telegram message for a clean scan');
});

test('CRON-RECON route: findings trigger one Telegram message per alert class, built by the message builder', async () => {
  const { GET } = await loadRoute();
  resetFakes();
  g.__cronScanResult = {
    generatedAt: '2026-09-06T06:00:00.000Z',
    windowFrom: '2026-08-30T06:00:00.000Z',
    checked: 2,
    summary: { PROVIDER_SUCCESS_DB_NOT_PAID: 1, AMOUNT_MISMATCH: 1 },
    findings: [
      { classification: 'PROVIDER_SUCCESS_DB_NOT_PAID', order_number: 'ORD-1' },
      { classification: 'AMOUNT_MISMATCH', order_number: 'ORD-2' },
    ],
    alerts: [
      { alertClass: 'PROVIDER_SUCCESS_DB_NOT_PAID', orderNumbers: ['ORD-1'] },
      { alertClass: 'AMOUNT_MISMATCH', orderNumbers: ['ORD-2'] },
    ],
  };
  const res = await GET(req(bearer('test-cron-secret')));
  assert.equal(res.status, 200);
  assert.deepEqual(g.__cronTexts, [
    'ALERT:PROVIDER_SUCCESS_DB_NOT_PAID:ORD-1',
    'ALERT:AMOUNT_MISMATCH:ORD-2',
  ]);
  const body = (await res.json()) as {
    notifications: Array<{ alert_class: string; orders_total: number; telegram: { sent: boolean } }>;
    alerts: Array<{ alertClass: string; orderNumbers: string[] }>;
  };
  assert.deepEqual(
    body.notifications.map((n) => [n.alert_class, n.orders_total, n.telegram.sent]),
    [
      ['PROVIDER_SUCCESS_DB_NOT_PAID', 1, true],
      ['AMOUNT_MISMATCH', 1, true],
    ]
  );
  assert.equal(body.alerts.length, 2);
});

test('CRON-RECON route: a Telegram failure never degrades the 200 summary', async () => {
  const { GET } = await loadRoute();
  resetFakes();
  g.__cronScanResult = {
    generatedAt: '2026-09-06T06:00:00.000Z',
    windowFrom: '2026-08-30T06:00:00.000Z',
    checked: 1,
    summary: { PROVIDER_SUCCESS_DB_NOT_PAID: 1 },
    findings: [{ classification: 'PROVIDER_SUCCESS_DB_NOT_PAID', order_number: 'ORD-1' }],
    alerts: [{ alertClass: 'PROVIDER_SUCCESS_DB_NOT_PAID', orderNumbers: ['ORD-1'] }],
  };
  g.__cronSendThrow = new Error('network down');
  try {
    const res = await GET(req(bearer('test-cron-secret')));
    assert.equal(res.status, 200, 'alert failure must not fail the cron endpoint');
    const body = (await res.json()) as {
      notifications: Array<{ telegram: { sent: boolean; reason?: string } }>;
    };
    assert.equal(body.notifications[0]!.telegram.sent, false);
    assert.equal(body.notifications[0]!.telegram.reason, 'unexpected');
  } finally {
    g.__cronSendThrow = undefined;
  }
});

test('CRON-RECON route: scan failure answers 500, never a fake all-clear', async () => {
  const { GET } = await loadRoute();
  resetFakes();
  g.__cronScanThrow = new Error('RECON_SCAN_DB_UNCONFIGURED');
  try {
    const res = await GET(req(bearer('test-cron-secret')));
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'Reconciliation failed');
  } finally {
    g.__cronScanThrow = undefined;
  }
});

// ---------------- route: static structure invariants ----------------

// Strip block comments so doc mentions (e.g. "does NOT use requireAdminApi")
// cannot false-positive structural assertions.
const routeCode = routeSource.replace(/\/\*[\s\S]*?\*\//g, '');

test('CRON-RECON route: NO admin session required (cron has no cookie/session)', () => {
  assert.doesNotMatch(routeCode, /requireAdminApi|admin-api|cookies\(|createServerClient/);
  assert.match(routeCode, /CRON_SECRET/, 'bearer auth via CRON_SECRET only');
});

test('CRON-RECON route: GET-only, read-only, classification reused not reimplemented', () => {
  assert.match(routeCode, /export async function GET\(/);
  assert.doesNotMatch(routeCode, /export\s+(async\s+)?function\s+(POST|PATCH|PUT|DELETE)\b/);
  // The route performs NO direct DB access at all (`.from(`) — all reads live
  // in the scan module; write-call invariants are pinned there.
  assert.ok(!routeCode.includes('.from('), 'route must not access the DB directly');
  const scanSource = readFileSync(
    path.join(root, 'app/lib/payment/reconciliation-scan.ts'),
    'utf8'
  );
  for (const m of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(']) {
    assert.ok(!scanSource.includes(m), `forbidden DB write call found in scan module: ${m}`);
  }
  assert.match(scanSource, /\.select\(/, 'scan module reads orders (SELECT-only)');
  assert.match(routeSource, /@\/app\/lib\/payment\/reconciliation-scan/);
  assert.doesNotMatch(
    routeSource,
    /classifyReconcileRow|mapLiqPayStatus|sameMoneyCents/,
    'route must not touch classifier internals — scan module owns orchestration'
  );
  assert.match(routeSource, /maxDuration = 60/, 'bounded workload contract');
});
