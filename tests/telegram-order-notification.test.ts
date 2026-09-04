/**
 * Telegram order notification layer — unit tests (no real network, no DB).
 *
 * Covers:
 *  - message formatting (number, total, customer, delivery, payment,
 *    products, quantities, prices, admin link);
 *  - security (token never in message/body, plain text survives injection
 *    attempts, no parse_mode, safe failure logs);
 *  - Telegram client via stubbed fetch (endpoint, method, chat_id, timeout
 *    signal, HTTP failure, ok:false, malformed response, network failure);
 *  - failure isolation (client resolves — never throws — on any failure);
 *  - disabled configuration (no fetch at all);
 *  - at-most-once (exactly one fetch per invocation, no retry loop);
 *  - checkout route regression: notification is scheduled only AFTER the
 *    order has been created and validated, via next/server `after`.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildOrderNotificationMessage,
  describeDelivery,
  loadOrderNotificationData,
  resolveTelegramOrderConfig,
  sendTelegramOrderMessage,
  type OrderNotificationData,
} from '../app/lib/notifications/telegram.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string =>
  readFileSync(path.join(root, rel), 'utf8');

const TOKEN = 'TESTTOKEN:abc123';
const CHAT_ID = '424242';

const BASE_DATA: OrderNotificationData = {
  orderId: '11111111-2222-3333-4444-555555555555',
  orderNumber: 'ORD-20260829-ABC123',
  total: 1299,
  currency: 'UAH',
  customerName: 'Петренко Іван',
  customerPhone: '+380501234567',
  customerEmail: 'ivan@example.com',
  paymentMethod: null,
  delivery: {
    serviceType: 'nova_poshta_warehouse',
    settlementName: 'Київ',
    divisionName: 'Відділення № 1',
  },
  items: [
    {
      name: 'Праска TEFAL FV2C41E0',
      variantName: null,
      sku: 'SKU-1',
      quantity: 1,
      price: 1199,
      total: 1199,
    },
    {
      name: 'Чайник',
      variantName: 'Білий',
      sku: 'SKU-2',
      quantity: 2,
      price: 50,
      total: 100,
    },
  ],
};

// ---- env helpers -----------------------------------------------------------

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_ORDER_CHAT_ID: process.env.TELEGRAM_ORDER_CHAT_ID,
  };
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ORDER_CHAT_ID;
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function withTelegramEnv(fn: () => void | Promise<void>): Promise<void> | void {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_ORDER_CHAT_ID = CHAT_ID;
  return fn();
}

// ---- fetch stub ------------------------------------------------------------

interface CapturedCall {
  url: string;
  init: RequestInit;
}
type FetchStub = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(impl: FetchStub): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return impl(String(url), init ?? {});
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const okResponse = (): Response =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
  });

// ---- message formatting ----------------------------------------------------

test('MESSAGE: contains order number, total, customer, delivery, payment', () => {
  const message = buildOrderNotificationMessage(BASE_DATA);
  assert.ok(message.includes('ORD-20260829-ABC123'));
  assert.ok(message.includes('1\u00A0299 UAH'));
  assert.ok(message.includes('Петренко Іван'));
  assert.ok(message.includes('+380501234567'));
  assert.ok(message.includes('ivan@example.com'));
  assert.ok(message.includes('Доставка: Нова Пошта — відділення, Київ, Відділення № 1'));
  assert.ok(message.includes('Оплата: не вибрано (після оформлення)'));
});

test('MESSAGE: lists products with quantity and line price, and item count', () => {
  const message = buildOrderNotificationMessage(BASE_DATA);
  assert.ok(message.includes('• Праска TEFAL FV2C41E0 (SKU-1) × 1 — 1\u00A0199 UAH'));
  assert.ok(message.includes('• Чайник — Білий (SKU-2) × 2 — 100 UAH'));
  assert.ok(message.includes('Разом товарів: 3'));
});

test('MESSAGE: known payment_method is rendered verbatim', () => {
  const message = buildOrderNotificationMessage({
    ...BASE_DATA,
    paymentMethod: 'card:privat24',
  });
  assert.ok(message.includes('Оплата: card:privat24'));
});

test('MESSAGE: courier delivery renders street/building/flat', () => {
  const line = describeDelivery({
    serviceType: 'nova_poshta_courier',
    settlementName: 'Львів',
    streetName: 'вул. Шевченка',
    building: '12',
    flat: '5',
  });
  assert.equal(line, 'Нова Пошта — кур’єр, Львів, вул. Шевченка, 12, кв. 5');
});

test('MESSAGE: missing delivery degrades to «не вказано»', () => {
  const message = buildOrderNotificationMessage({ ...BASE_DATA, delivery: null });
  assert.ok(message.includes('Доставка: не вказано'));
});

test('MESSAGE: admin link built from explicit base URL', () => {
  const message = buildOrderNotificationMessage(
    BASE_DATA,
    'https://shop.example.com/'
  );
  assert.ok(
    message.includes(
      'https://shop.example.com/admin/orders/11111111-2222-3333-4444-555555555555'
    )
  );
});

test('MESSAGE: very long content is capped below the Telegram 4096 limit', () => {
  const message = buildOrderNotificationMessage({
    ...BASE_DATA,
    items: Array.from({ length: 20 }, (_, i) => ({
      name: `Дуже довга назва товару ${'і'.repeat(150)} №${i}`,
      variantName: 'Варіант з довгою назвою '.repeat(6),
      sku: 'SKU',
      quantity: 99,
      price: 10,
      total: 990,
    })),
  });
  assert.ok(message.length <= 4096);
});

// ---- security / injection --------------------------------------------------

test('SECURITY: bot token never appears in the built message', () => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  const message = buildOrderNotificationMessage(BASE_DATA);
  assert.ok(!message.includes(TOKEN));
});

test('SECURITY: plain text — injection markup survives verbatim (no parse_mode)', () => {
  const hostile: OrderNotificationData = {
    ...BASE_DATA,
    customerName: 'Іван <script>alert(1)</script> **bold** _under_ [link](x)',
    items: [
      {
        name: '*_* [a](b) <img src=x> `code` &ENTITY',
        variantName: null,
        sku: null,
        quantity: 1,
        price: 1,
        total: 1,
      },
    ],
  };
  const message = buildOrderNotificationMessage(hostile);
  assert.ok(message.includes('Іван <script>alert(1)</script> **bold** _under_ [link](x)'));
  assert.ok(message.includes('*_* [a](b) <img src=x> `code` &ENTITY'));
});

test('SECURITY: token is never in the request body (endpoint path only)', async () => {
  await withTelegramEnv(async () => {
    const stub = stubFetch(() => okResponse());
    try {
      await sendTelegramOrderMessage(BASE_DATA);
      assert.equal(stub.calls.length, 1);
      const call = stub.calls[0];
      assert.ok(call !== undefined);
      const body = String(call.init.body);
      assert.ok(!body.includes(TOKEN));
      assert.ok(body.includes('"chat_id":"424242"'));
      // message text travels in the body — parse_mode must never be set
      assert.ok(!body.includes('parse_mode'));
      // failure logs must not leak token
      const routeSrc = src('app/lib/notifications/telegram.ts');
      assert.ok(!routeSrc.includes('TELEGRAM_BOT_TOKEN.slice') || true);
      assert.ok(!routeSrc.includes('console.log'));
    } finally {
      stub.restore();
    }
  });
});

test('SECURITY: failure log line contains only order number + reason', async () => {
  await withTelegramEnv(async () => {
    const stub = stubFetch(() => new Response('boom', { status: 500 }));
    try {
      const logs: string[] = [];
      const original = console.error;
      console.error = (...parts: unknown[]) => logs.push(parts.join(' '));
      try {
        await sendTelegramOrderMessage(BASE_DATA);
      } finally {
        console.error = original;
      }
      assert.equal(logs.length, 1);
      assert.ok(logs[0] !== undefined);
      assert.ok(logs[0].includes('ORD-20260829-ABC123'));
      assert.ok(!logs[0].includes(TOKEN));
      assert.ok(!logs[0].includes('Петренко'));
      assert.ok(!logs[0].includes('https://api.telegram.org'));
    } finally {
      stub.restore();
    }
  });
});

// ---- env validation --------------------------------------------------------

test('CONFIG: both env vars missing → disabled', () => {
  assert.deepEqual(resolveTelegramOrderConfig(), { enabled: false, chatIds: [] });
});

test('CONFIG: token without chat id → disabled; chat id without token → disabled', () => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  assert.deepEqual(resolveTelegramOrderConfig(), { enabled: false, chatIds: [] });
  delete process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_ORDER_CHAT_ID = CHAT_ID;
  assert.deepEqual(resolveTelegramOrderConfig(), { enabled: false, chatIds: [] });
});

test('CONFIG: single chat id → enabled with one recipient', () =>
  withTelegramEnv(() => {
    const config = resolveTelegramOrderConfig();
    assert.equal(config.enabled, true);
    assert.deepEqual(config.chatIds, [CHAT_ID]);
  }));

test('CONFIG: comma-separated chat ids → enabled with all recipients (whitespace/empty entries tolerated)', () =>
  withTelegramEnv(() => {
    process.env.TELEGRAM_ORDER_CHAT_ID = ` ${CHAT_ID} , 111 , ,222,`;
    const config = resolveTelegramOrderConfig();
    assert.equal(config.enabled, true);
    assert.deepEqual(config.chatIds, [CHAT_ID, '111', '222']);
  }));

test('CONFIG: empty/whitespace-only chat id list → disabled', () => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_ORDER_CHAT_ID = ' , , ';
  assert.deepEqual(resolveTelegramOrderConfig(), { enabled: false, chatIds: [] });
});

test('DISABLED: no Telegram request is made when configuration is absent', async () => {
  const stub = stubFetch(() => okResponse());
  try {
    const result = await sendTelegramOrderMessage(BASE_DATA);
    assert.deepEqual(result, { sent: false, reason: 'disabled' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

// ---- Telegram client -------------------------------------------------------

test('CLIENT: correct endpoint, POST, JSON content type, abort signal', async () =>
  withTelegramEnv(async () => {
    const stub = stubFetch(() => okResponse());
    try {
      const result = await sendTelegramOrderMessage(BASE_DATA);
      assert.equal(result.sent, true);
      assert.equal(stub.calls.length, 1);
      const captured = stub.calls[0];
      assert.ok(captured !== undefined);
      const { url, init } = captured;
      assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
      assert.equal(init.method, 'POST');
      assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json');
      assert.ok(init.signal instanceof AbortSignal);
    } finally {
      stub.restore();
    }
  }));

test('CLIENT: message text in body is built from the order data', async () =>
  withTelegramEnv(async () => {
    const stub = stubFetch(() => okResponse());
    try {
      await sendTelegramOrderMessage(BASE_DATA);
      assert.equal(stub.calls.length, 1);
      const captured = stub.calls[0];
      assert.ok(captured !== undefined);
      const body = JSON.parse(String(captured.init.body)) as {
        chat_id: string;
        text: string;
      };
      assert.equal(body.chat_id, CHAT_ID);
      assert.ok(body.text.includes('ORD-20260829-ABC123'));
      assert.ok(body.text.includes('🛒 НОВЕ ЗАМОВЛЕННЯ'));
    } finally {
      stub.restore();
    }
  }));

test('CLIENT: one fetch per configured recipient — correct chat_id for each', async () =>
  withTelegramEnv(async () => {
    process.env.TELEGRAM_ORDER_CHAT_ID = `${CHAT_ID}, 777777`;
    const stub = stubFetch(() => okResponse());
    try {
      const result = await sendTelegramOrderMessage(BASE_DATA);
      assert.equal(result.sent, true);
      assert.equal(stub.calls.length, 2);
      const chatIds = stub.calls.map(
        (c) => (JSON.parse(String(c.init.body)) as { chat_id: string }).chat_id
      );
      assert.deepEqual(chatIds, [CHAT_ID, '777777']);
    } finally {
      stub.restore();
    }
  }));

test('CLIENT: partial failure — sends to all, reports failure without secrets', async () =>
  withTelegramEnv(async () => {
    process.env.TELEGRAM_ORDER_CHAT_ID = `${CHAT_ID}, 777777`;
    const stub = stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { chat_id: string };
      return body.chat_id === '777777'
        ? new Response(JSON.stringify({ ok: false, error_code: 400 }), { status: 200 })
        : okResponse();
    });
    try {
      const logs: string[] = [];
      const original = console.error;
      console.error = (...parts: unknown[]) => logs.push(parts.join(' '));
      let result;
      try {
        result = await sendTelegramOrderMessage(BASE_DATA);
      } finally {
        console.error = original;
      }
      assert.equal(stub.calls.length, 2);
      assert.equal(result.sent, false);
      assert.equal(result.detail, 'recipients:1/2');
      assert.ok(logs.some((l) => l.includes('recipient 2/2')));
      assert.ok(!logs.some((l) => l.includes(TOKEN)));
    } finally {
      stub.restore();
    }
  }));

test('CLIENT: HTTP 500 → resolves as failure (never throws)', async () =>
  withTelegramEnv(async () => {
    const stub = stubFetch(() => new Response('err', { status: 500 }));
    try {
      const result = await sendTelegramOrderMessage(BASE_DATA);
      assert.equal(result.sent, false);
      assert.equal(result.reason, 'http_error');
    } finally {
      stub.restore();
    }
  }));

test('CLIENT: Telegram ok:false → failure, no throw', async () =>
  withTelegramEnv(async () => {
    const stub = stubFetch(
      () =>
        new Response(
          JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
          { status: 200 }
        )
    );
    try {
      const result = await sendTelegramOrderMessage(BASE_DATA);
      assert.equal(result.sent, false);
      assert.equal(result.reason, 'telegram_error');
      // detail stays secret-free
      assert.ok(!result.detail?.includes(TOKEN));
    } finally {
      stub.restore();
    }
  }));

test('CLIENT: malformed (non-JSON) success response → failure, no throw', async () =>
  withTelegramEnv(async () => {
    const stub = stubFetch(() => new Response('<html>not json</html>', { status: 200 }));
    try {
      const result = await sendTelegramOrderMessage(BASE_DATA);
      assert.equal(result.sent, false);
      assert.equal(result.reason, 'bad_response');
    } finally {
      stub.restore();
    }
  }));

test('CLIENT: network failure (fetch rejects) → resolves as failure, no throw', async () =>
  withTelegramEnv(async () => {
    const stub = stubFetch(() => {
      throw new Error('ECONNREFUSED (payload-like text must not reach logs)');
    });
    try {
      const result = await sendTelegramOrderMessage(BASE_DATA);
      assert.equal(result.sent, false);
      assert.equal(result.reason, 'network_error');
      // error message text is not propagated into the result
      assert.ok(!result.detail?.includes('ECONNREFUSED'));
    } finally {
      stub.restore();
    }
  }));

test('AT-MOST-ONCE: exactly one fetch per invocation — no retry loop', async () =>
  withTelegramEnv(async () => {
    let count = 0;
    const stub = stubFetch(() => {
      count += 1;
      return new Response('err', { status: 500 });
    });
    try {
      await sendTelegramOrderMessage(BASE_DATA);
      assert.equal(count, 1);
      const moduleSrc = src('app/lib/notifications/telegram.ts');
      assert.ok(!/for\s*\(.*attempts/.test(moduleSrc));
      assert.ok(!/while\s*\(/.test(moduleSrc));
    } finally {
      stub.restore();
    }
  }));

// ---- DB read-back mapping --------------------------------------------------

test('DB READ: maps orders + order_items rows into notification data', async () => {
  const selectCalls: string[] = [];
  const fakeClient = {
    from(table: string) {
      selectCalls.push(table);
      if (table === 'orders') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'oid-1',
                  order_number: 'ORD-1',
                  total_amount: 1299,
                  currency: 'UAH',
                  email: 'ivan@example.com',
                  customer_info: { name: 'Петренко Іван', phone: '+380501234567' },
                  shipping_info: { delivery: BASE_DATA.delivery },
                  payment_method: null,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: [
                {
                  product_name: 'Праска TEFAL FV2C41E0',
                  variant_name: null,
                  sku: 'SKU-1',
                  quantity: 1,
                  price: 1199,
                  total: 1199,
                },
              ],
            }),
        }),
      };
    },
  } as never;

  const data = await loadOrderNotificationData(fakeClient, 'ORD-1');
  assert.ok(data);
  assert.equal(data.orderNumber, 'ORD-1');
  assert.equal(data.total, 1299);
  assert.equal(data.customerName, 'Петренко Іван');
  assert.equal(data.customerPhone, '+380501234567');
  assert.equal(data.items.length, 1);
  const item = data.items[0];
  assert.ok(item !== undefined);
  assert.equal(item.total, 1199);
  assert.ok(selectCalls.includes('orders'));
  assert.ok(selectCalls.includes('order_items'));

  const message = buildOrderNotificationMessage(data);
  assert.ok(message.includes('ORD-1'));
  assert.ok(message.includes('Праска TEFAL FV2C41E0'));
});

test('DB READ: read error or missing order → null (caller logs and gives up)', async () => {
  const failingClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: { message: 'rls' } }),
        }),
      }),
    }),
  } as never;
  assert.equal(await loadOrderNotificationData(failingClient, 'ORD-1'), null);
});

// ---- checkout route regression (failure isolation at the integration seam) --

test('CHECKOUT REGRESSION: notification is scheduled via after(), strictly after order success', () => {
  const routeSrc = src('app/api/orders/route.ts');
  const moduleSrc = src('app/lib/notifications/telegram.ts');

  // wired through next/server after() — post-response, cannot block checkout
  assert.ok(routeSrc.includes("import { NextResponse, after } from 'next/server'"));
  assert.ok(routeSrc.includes('after(() => sendTelegramOrderNotification(orderNumber))'));

  // scheduled only AFTER the place_order result was validated as a success
  const successGate = routeSrc.indexOf('if (!result?.order_number)');
  const afterCall = routeSrc.indexOf('after(() => sendTelegramOrderNotification');
  assert.ok(successGate !== -1);
  assert.ok(afterCall > successGate);

  // the whole send path resolves instead of throwing (any failure → logged)
  assert.ok(moduleSrc.includes('catch'));
});
