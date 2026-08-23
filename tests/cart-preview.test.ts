/**
 * Tests for fetchCartPreview: proves the "always settles" invariant.
 * Uses real HTTP servers (no browser needed).
 * Run: npm test
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  fetchCartPreview,
  PREVIEW_NETWORK_ERROR,
  type CartPreviewLine,
} from '../app/lib/cart-preview.ts';

const PID = '11111111-1111-1111-1111-111111111111';

interface TestCtx {
  server: http.Server;
  url: string;
}

const contexts: TestCtx[] = [];

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<TestCtx> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const ctx = { server, url: `http://127.0.0.1:${addr.port}/api/cart-preview` };
  contexts.push(ctx);
  return ctx;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    ctx?.server.closeAllConnections();
    await new Promise<void>((resolve) => ctx?.server.close(() => resolve()));
  }
});

test('stalled server: request settles via timeout with friendly error', async () => {
  const ctx = await startServer(() => {
    /* intentionally never respond */
  });

  const events: string[] = [];
  let error: string | null = null;
  let doneCalled = false;

  const start = Date.now();
  fetchCartPreview([{ productId: PID, variantId: null }], {
    onData: () => events.push('onData'),
    onError: (m) => {
      events.push('onError');
      error = m;
    },
    onDone: () => {
      events.push('onDone');
      doneCalled = true;
    },
  }, { url: ctx.url, timeoutMs: 250 });

  await new Promise((r) => setTimeout(r, 900));
  const elapsed = Date.now() - start;

  assert.ok(doneCalled, 'onDone must fire');
  assert.deepEqual(events, ['onError', 'onDone']);
  assert.equal(error, PREVIEW_NETWORK_ERROR);
  assert.ok(elapsed < 1200, `settled in ${elapsed}ms, must be bounded`);
});

test('successful response delivers preview lines', async () => {
  const ctx = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      assert.equal(req.method, 'POST');
      const parsed = JSON.parse(body);
      assert.deepEqual(parsed.items, [{ productId: PID, variantId: null }]);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          items: [
            {
              productId: PID,
              variantId: null,
              found: true,
              name: 'Тест',
              slug: 'test',
              variantName: null,
              unitPrice: 9.99,
              currency: 'UAH',
              stock: 5,
              availabilityStatus: 'in_stock',
              imageUrl: null,
            },
          ],
        })
      );
    });
  });

  const events: string[] = [];
  let data: CartPreviewLine[] = [];

  fetchCartPreview([{ productId: PID, variantId: null }], {
    onData: (d) => {
      events.push('onData');
      data = d;
    },
    onError: () => events.push('onError'),
    onDone: () => events.push('onDone'),
  }, { url: ctx.url, timeoutMs: 1000 });

  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(events, ['onData', 'onDone']);
  assert.equal(data[0]?.name, 'Тест');
  assert.equal(data[0]?.unitPrice, 9.99);
});

test('HTTP 500 surfaces the server error message', async () => {
  const ctx = await startServer((_req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Помилка пошуку' }));
  });

  let error: string | null = null;
  const events: string[] = [];

  fetchCartPreview([{ productId: PID, variantId: null }], {
    onData: () => events.push('onData'),
    onError: (m) => {
      events.push('onError');
      error = m;
    },
    onDone: () => events.push('onDone'),
  }, { url: ctx.url, timeoutMs: 1000 });

  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(events, ['onError', 'onDone']);
  assert.equal(error, 'Помилка пошуку');
});

test('HTTP 429 surfaces rate-limit message instead of hanging', async () => {
  const ctx = await startServer((_req, res) => {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Забагато запитів. Спробуйте пізніше' }));
  });

  let error: string | null = null;

  fetchCartPreview([{ productId: PID, variantId: null }], {
    onData: () => {},
    onError: (m) => {
      error = m;
    },
    onDone: () => {},
  }, { url: ctx.url, timeoutMs: 1000 });

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(error, 'Забагато запитів. Спробуйте пізніше');
});

test('200 with non-JSON body degrades to empty lines', async () => {
  const ctx = await startServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html>oops</html>');
  });

  const events: string[] = [];
  let data: CartPreviewLine[] | null = null;

  fetchCartPreview([{ productId: PID, variantId: null }], {
    onData: (d) => {
      events.push('onData');
      data = d;
    },
    onError: () => events.push('onError'),
    onDone: () => events.push('onDone'),
  }, { url: ctx.url, timeoutMs: 1000 });

  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(events, ['onData', 'onDone']);
  assert.deepEqual(data, []);
});

test('dispose() mid-flight silences every callback', async () => {
  const ctx = await startServer(() => {
    /* hold the request open */
  });

  const events: string[] = [];
  const dispose = fetchCartPreview([{ productId: PID, variantId: null }], {
    onData: () => events.push('onData'),
    onError: () => events.push('onError'),
    onDone: () => events.push('onDone'),
  }, { url: ctx.url, timeoutMs: 10_000 });

  setTimeout(() => dispose(), 80);
  await new Promise((r) => setTimeout(r, 500));

  assert.deepEqual(events, [], 'no callbacks may fire after dispose');
});
