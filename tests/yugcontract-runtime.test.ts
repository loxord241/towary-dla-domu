/**
 * RUNTIME integration test for the Yugcontract client against a REAL
 * local HTTP server (node:http + real fetch over sockets).
 *
 * This verifies the full transport path: JWT request token delivery,
 * Bearer authToken flow, 401 re-auth + single retry, malformed bodies.
 * It does NOT hit the real Yugcontract API — real-credential runs are
 * only possible after YUGCONTRACT_USER_KEY / YUGCONTRACT_SECRET are set.
 * Run: npm test
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Each node:test file is a separate process — set fake credentials here.
process.env.YUGCONTRACT_USER_KEY ??= 'runtime-user-key';
process.env.YUGCONTRACT_SECRET ??= 'runtime-secret';

const {
  getPriceCatalog,
  getCategoriesCatalog,
  resetAuthTokenCacheForTests,
} = await import('../app/lib/yugcontract/client.ts');

const USER_KEY = 'runtime-user-key';
const SECRET = 'runtime-secret';

interface ReceivedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Local scripted API server: routes get-auth-token / get-price / get-categories. */
function startServer(
  handler: (req: ReceivedRequest) => { status: number; body?: unknown; raw?: string }
): Promise<{ port: number; requests: ReceivedRequest[]; close: () => Promise<void> }> {
  const requests: ReceivedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const received: ReceivedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
      requests.push(received);
      // A throwing script must never leave the client hanging until its
      // long transport timeout — answer 500 instead of crashing silently.
      let out;
      try {
        out = handler(received);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
        return;
      }
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.raw ?? JSON.stringify(out.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve({
        port: address.port,
        requests,
        close: () =>
          new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function withServer(
  handler: Parameters<typeof startServer>[0],
  run: (port: number, requests: ReceivedRequest[]) => Promise<void>
): Promise<void> {
  const server = await startServer(handler);
  process.env.YUGCONTRACT_AUTH_URL = `http://127.0.0.1:${server.port}/get-auth-token`;
  process.env.YUGCONTRACT_PRICE_URL = `http://127.0.0.1:${server.port}/get-price`;
  // Critical: keep every Yugcontract request on localhost — never hit the
  // real B2B API from tests.
  process.env.YUGCONTRACT_CATEGORIES_URL = `http://127.0.0.1:${server.port}/get-categories`;
  try {
    await run(server.port, server.requests);
  } finally {
    await server.close();
  }
}

beforeEach(() => {
  resetAuthTokenCacheForTests();
});

after(() => {
  delete process.env.YUGCONTRACT_AUTH_URL;
  delete process.env.YUGCONTRACT_PRICE_URL;
  delete process.env.YUGCONTRACT_CATEGORIES_URL;
});

test('runtime: full auth+price happy path over real HTTP', async () => {
  await withServer(
    (req) => {
      if (req.url === '/get-auth-token') {
        return { status: 200, body: { content: { authToken: 'RUNTIME-TOKEN' } } };
      }
      return { status: 200, body: { content: { data: { rests: { product: [] } } } } };
    },
    async (_port, requests) => {
      const result = await getPriceCatalog({});
      assert.deepEqual(result, { content: { data: { rests: { product: [] } } } });

      assert.equal(requests.length, 2);
      const [authReq, priceReq] = requests;

      // Auth: POST JSON with a well-formed HS256 requestToken JWT that
      // carries the user key — and NOT the secret.
      assert.equal(authReq.method, 'POST');
      const authBody = JSON.parse(authReq.body);
      assert.match(
        authBody.requestToken,
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
      );
      const [, jwtPayload] = authBody.requestToken.split('.');
      const payload = JSON.parse(Buffer.from(jwtPayload, 'base64url').toString());
      assert.equal(payload.user_key, USER_KEY);
      assert.equal(payload.algorithm, 'HS256');
      assert.equal(payload.exp - payload.iat, 180);
      assert.ok(!authReq.body.includes(SECRET));

      // Price: Bearer token header, documented body defaults.
      assert.equal(priceReq.headers.authorization, 'Bearer RUNTIME-TOKEN');
      const priceBody = JSON.parse(priceReq.body);
      assert.deepEqual(priceBody, {
        format: 'json',
        type: 'regular',
        cats: [],
        ext_cols: [],
        type_prod: [],
      });
    }
  );
});

test('runtime: 401 triggers one re-auth + retry over real HTTP', async () => {
  const state = { authCount: 0, priceCount: 0 };
  await withServer(
    (req) => {
      if (req.url === '/get-auth-token') {
        state.authCount += 1;
        return { status: 200, body: { content: { authToken: `T${state.authCount}` } } };
      }
      // First price call fails, second succeeds.
      state.priceCount += 1;
      return state.priceCount === 1
        ? { status: 401, body: { error: 'token expired' } }
        : { status: 200, body: { content: { data: { rests: { product: [{ id: 7 }] } } } } };
    },
    async (_port, requests) => {
      const result = await getPriceCatalog({});
      assert.deepEqual(result, { content: { data: { rests: { product: [{ id: 7 }] } } } });

      const priceReqs = requests.filter((r) => r.url === '/get-price');
      const authReqs = requests.filter((r) => r.url === '/get-auth-token');
      assert.equal(priceReqs.length, 2); // original + exactly ONE retry
      assert.equal(authReqs.length, 2); // initial + refresh
      assert.equal(priceReqs[0].headers.authorization, 'Bearer T1');
      assert.equal(priceReqs[1].headers.authorization, 'Bearer T2');
    }
  );
});

test('runtime: malformed (non-JSON) price response raises malformed', async () => {
  await withServer(
    (req) =>
      req.url === '/get-auth-token'
        ? { status: 200, body: { content: { authToken: 'T' } } }
        : { status: 200, raw: '<html>not json</html>' },
    async (_port, requests) => {
      await assert.rejects(getPriceCatalog({}), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /не JSON|Некоректна/u);
        return true;
      });
      assert.equal(requests.length, 2);
    }
  );
});

test('runtime: get-categories happy path reuses the cached auth token', async () => {
  await withServer(
    (req) => {
      if (req.url === '/get-auth-token') {
        return { status: 200, body: { content: { authToken: 'CAT-TOKEN' } } };
      }
      if (req.url !== '/get-categories') {
        return { status: 500, body: { error: 'unexpected route in categories test' } };
      }
      return {
        status: 200,
        body: {
          content: {
            data: {
              categories: [
                { id: 1, parent_id: 0, name_ukr: 'Корінь' },
                { id: 2, parent_id: 1, name_ukr: 'Дитина' },
              ],
            },
          },
        },
      };
    },
    async (_port, requests) => {
      const result = (await getCategoriesCatalog()) as {
        content: { data: { categories: unknown[] } };
      };
      assert.equal(result.content.data.categories.length, 2);

      const authReqs = requests.filter((r) => r.url === '/get-auth-token');
      const catReqs = requests.filter((r) => r.url === '/get-categories');
      assert.equal(authReqs.length, 1); // token requested once…
      assert.equal(catReqs.length, 1);
      // …and reused as Bearer for the categories call.
      assert.equal(catReqs[0].headers.authorization, 'Bearer CAT-TOKEN');
      const catBody = JSON.parse(catReqs[0].body);
      assert.deepEqual(catBody, { format: 'json', type: 'regular' });
    }
  );
});

test('runtime: categories 401 triggers one re-auth + retry', async () => {
  const state = { authCount: 0, catCount: 0 };
  await withServer(
    (req) => {
      if (req.url === '/get-auth-token') {
        state.authCount += 1;
        return { status: 200, body: { content: { authToken: `CT${state.authCount}` } } };
      }
      state.catCount += 1;
      return state.catCount === 1
        ? { status: 401, body: { error: 'expired' } }
        : {
            status: 200,
            body: { content: { data: { categories: [{ id: 5, name_ukr: 'X' }] } } },
          };
    },
    async (_port, requests) => {
      const result = (await getCategoriesCatalog()) as {
        content: { data: { categories: unknown[] } };
      };
      assert.equal(result.content.data.categories.length, 1);

      const catReqs = requests.filter((r) => r.url === '/get-categories');
      assert.equal(catReqs.length, 2); // original + ONE retry
      assert.equal(catReqs[0].headers.authorization, 'Bearer CT1');
      assert.equal(catReqs[1].headers.authorization, 'Bearer CT2');
    }
  );
});
