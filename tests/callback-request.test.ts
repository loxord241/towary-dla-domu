/**
 * «Передзвоніть мені» (callback request, v1 = owner Telegram, no table).
 *
 * Covers the moving parts end to end:
 *   1. POST /api/products/callback-request — the two content 400s a real
 *      customer can fix («Вкажіть ваше ім'я» / «Некоректний номер
 *      телефону», the phone normalized by the SAME normalizeUaPhoneDigits
 *      the checkout uses and sent as E.164 +380XXXXXXXXX, matching the
 *      /api/orders server-side rule); honeypot and non-uuid/unknown
 *      product ids answer the SAME generic `200 { ok: true }` (no oracle,
 *      no send); rate limit `callbackRequest` per IP (3/10min + 8/hour,
 *      REAL limiter source); telegram via sendTelegramText — sent:false or
 *      a throw both answer the same generic 500 («v1 has no table, so
 *      success is never faked»); no internals in any response;
 *   2. CallbackRequest client component — toggle button → name+phone form,
 *      success state, inline errors, never-stuck bounded fetch
 *      (AbortController + timeout, always settles), motion-reduce, mobile
 *      contract (text-base inputs, min-h-[44px] tap targets), honeypot;
 *   3. the PDP mounts it for EVERY product (no availability gate —
 *      unlike RestockNotify).
 *
 * Runtime coverage follows the project harness pattern (real route source
 * with only the untestable edges stubbed — next/server, @/ aliases and
 * the telegram lib are not resolvable/stub-friendly under plain
 * node:test; see tests/restock-notify.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const stripJsComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const ROUTE = 'app/api/products/callback-request/route.ts';
const COMPONENT = 'app/components/CallbackRequest.tsx';
const PDP = 'app/product/[slug]/page.tsx';

// ---------------------------------------------------------------------------
// 1. API route — static invariants
// ---------------------------------------------------------------------------

const routeCode = stripJsComments(src(ROUTE));

test('ROUTE: POST-only public endpoint, service-role client (no session)', () => {
  assert.match(routeCode, /export async function POST\(/);
  assert.doesNotMatch(
    routeCode,
    /export\s+(?:async\s+)?function\s+(GET|PUT|PATCH|DELETE)\b/,
    'App Router answers 405 for everything else; no read surface'
  );
  assert.match(routeCode, /from '@supabase\/supabase-js'/);
  assert.match(routeCode, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(routeCode, /persistSession: false/);
});

test('ROUTE: rate limit via the named callbackRequest rule (3/10min burst + 8/hour)', () => {
  assert.match(routeCode, /enforceRateLimit\(request, 'callbackRequest'\)/);
  const rl = stripJsComments(src('app/lib/rate-limit.ts'));
  assert.match(
    rl,
    /callbackRequest:\s*\[\s*\{\s*max:\s*3,\s*windowMs:\s*10 \* 60_000\s*\},\s*\{\s*max:\s*8,\s*windowMs:\s*60 \* 60_000\s*\},?\s*\]/
  );
});

test('ROUTE: the two content 400s + honeypot + anti-enumeration generic 200s', () => {
  assert.match(routeCode, /Вкажіть ваше ім'я/);
  assert.match(routeCode, /Некоректний номер телефону/);
  assert.match(routeCode, /status: 400/);
  // Honeypot drop and anti-enumeration share the generic success.
  assert.ok(
    (routeCode.match(/\{ ok: true \}/g) ?? []).length >= 3,
    'generic 200 must cover honeypot / non-uuid / unknown product / success'
  );
  assert.match(routeCode, /website/);
  assert.match(routeCode, /isCallbackUuid\(productId\)/);
});

test('ROUTE: phone normalization is the checkout normalizer, sent as E.164', () => {
  assert.match(
    routeCode,
    /import\s*\{\s*normalizeUaPhoneDigits\s*\}\s*from\s*'@\/app\/lib\/phone';/
  );
  assert.match(routeCode, /normalizeUaPhoneDigits\(rawPhone\)/);
  assert.match(routeCode, /nationalDigits\.length !== 9/);
  assert.match(routeCode, /\+380\$\{nationalDigits\}/);
  // Typo guard: a mangled digit count must 400 BEFORE the truncating
  // normalizer can silently turn it into a wrong-but-valid number.
  assert.match(routeCode, /digitCount !== 9 && digitCount !== 10 && digitCount !== 12/);
  const guardIdx = routeCode.indexOf('digitCount !== 9');
  const normIdx = routeCode.indexOf('normalizeUaPhoneDigits(rawPhone)');
  assert.ok(guardIdx !== -1 && normIdx !== -1 && guardIdx < normIdx, 'guard runs first');
});

test('ROUTE: telegram via sendTelegramText; undelivered = honest generic 500 (no table, success never faked)', () => {
  assert.match(
    routeCode,
    /import\s*\{\s*sendTelegramText\s*\}\s*from\s*'@\/app\/lib\/notifications\/telegram';/
  );
  assert.match(routeCode, /📞 Передзвоніть мені/);
  const sendIdx = routeCode.indexOf('await sendTelegramText(');
  const failIdx = routeCode.indexOf('if (!result.sent)');
  assert.ok(sendIdx !== -1 && failIdx !== -1 && failIdx > sendIdx);
  assert.match(routeCode, /Не вдалося надіслати запит/);
  assert.match(routeCode, /status: 500/);
  // No raw DB/telegram error text can reach a response body.
  assert.doesNotMatch(routeCode, /error\.message/);
});

// ---------------------------------------------------------------------------
// 2. UI component — static invariants
// ---------------------------------------------------------------------------

const componentCode = stripJsComments(src(COMPONENT));

test('COMPONENT: toggle button + contracted strings and inline errors', () => {
  assert.match(componentCode, /'use client'/);
  assert.match(componentCode, /Передзвоніть мені/);
  assert.match(componentCode, /Дякуємо! Ми зателефонуємо вам найближчим часом/);
  assert.match(componentCode, /CALLBACK_TIMEOUT_MS = 12_000/, 'bounded fetch budget');
  assert.match(componentCode, /role="alert"/, 'errors inline');
  assert.match(componentCode, /role="status"/, 'success is announced');
  assert.match(componentCode, /motion-reduce:transition-none/);
});

test('COMPONENT: mobile contract — 16px inputs, ≥44px tap targets, tel keyboard', () => {
  assert.match(componentCode, /type="tel"/);
  assert.match(componentCode, /inputMode="tel"/);
  assert.equal(
    (componentCode.match(/text-base/g) ?? []).length,
    2,
    'both inputs are text-base (16px, no iOS zoom)'
  );
  assert.equal(
    (componentCode.match(/min-h-\[44px\]/g) ?? []).length,
    4,
    'toggle button + both inputs + submit are ≥44px tap targets'
  );
});

test('COMPONENT: never-stuck — every submit settles (abort timer + finally + catch) + honeypot wired', () => {
  assert.match(componentCode, /new AbortController\(\)/);
  assert.match(componentCode, /setTimeout\(\(\) => controller\.abort\(\), CALLBACK_TIMEOUT_MS\)/);
  assert.match(componentCode, /finally\s*\{[\s\S]*?clearTimeout\(timer\)/);
  assert.match(componentCode, /\} catch \{/, 'network/abort path resolves, never throws');
  assert.match(componentCode, /res\.json\(\)\.catch\(\(\) => null\)/, 'body parse cannot hang the flow');
  assert.doesNotMatch(componentCode, /window\.|document\./, 'no direct DOM');
  // The honeypot value actually reaches the endpoint body (a dead field
  // would only catch bots that parse the DOM, not the ones that matter).
  assert.match(
    componentCode,
    /JSON\.stringify\(\{ productId, name, phone, website \}\)/,
    'honeypot state is sent in the body'
  );
  assert.match(componentCode, /name="website"/);
});

test('PDP: CallbackRequest mounted for EVERY product (no availability gate)', () => {
  const page = src(PDP);
  assert.match(page, /import CallbackRequest from '@\/app\/components\/CallbackRequest'/);
  assert.match(page, /<CallbackRequest productId=\{product\.id\} \/>/);
  assert.equal(
    (page.match(/<CallbackRequest/g) ?? []).length,
    1,
    'exactly one mount site'
  );
});

// ---------------------------------------------------------------------------
// Runtime harness: real route source, stubbed supabase + telegram,
// REAL rate limiter + REAL phone normalizer
// ---------------------------------------------------------------------------

interface RouteTestGlobal {
  __cbSends?: string[];
  __cbSendResult?: { sent: boolean; reason?: string };
  __cbSendThrow?: boolean;
  __cbClientCalls?: unknown[][];
  __cbProductReadError?: { message: string } | null;
  __cbProducts?: Record<string, { name: string; slug: string }>;
  __cbQueriedProductId?: unknown;
  __cbClientThrow?: boolean;
}
const g = globalThis as RouteTestGlobal;

function resetRouteFakes() {
  g.__cbSends = [];
  g.__cbSendResult = undefined;
  g.__cbSendThrow = false;
  g.__cbClientCalls = [];
  g.__cbProductReadError = null;
  g.__cbProducts = {};
  g.__cbQueriedProductId = undefined;
  g.__cbClientThrow = false;
}

interface RouteModule {
  POST: (request: Request) => Promise<Response>;
  isCallbackUuid: (value: unknown) => value is string;
  isValidCallbackName: (value: string) => boolean;
}

/**
 * Loads the REAL route with @supabase/supabase-js, the telegram lib and
 * the @/ aliases stubbed/loadable: the limiter is the REAL
 * app/lib/rate-limit.ts source (next/server shimmed, fresh module instance
 * per loadRoute → fresh buckets); the phone normalizer is the REAL
 * app/lib/phone.ts source; sendTelegramText is a spy on globalThis.
 */
async function loadRoute(): Promise<RouteModule> {
  const rlShim = `const NextResponse = { json: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), init) };`;
  const rlUrl = pathToFileURL(path.join(root, 'app/lib/rate-limit.ts')).href;
  const phoneUrl = pathToFileURL(path.join(root, 'app/lib/phone.ts')).href;
  const rlLoader = `
const rlFs = await import('node:fs');
const rlOs = await import('node:os');
const rlUrlMod = await import('node:url');
const rlSource = rlFs.readFileSync(rlUrlMod.fileURLToPath('${rlUrl}'), 'utf8').replace(
  /import\\s*\\{\\s*NextResponse\\s*\\}\\s*from\\s*'next\\/server';/,
  ${JSON.stringify(rlShim)}
);
const rlDir = rlFs.mkdtempSync(rlOs.tmpdir() + '/callback-rl-');
const rlFile = rlDir + '/rate-limit.mts';
rlFs.writeFileSync(rlFile, rlSource);
const rlMod = await import(rlUrlMod.pathToFileURL(rlFile).href);
const enforceRateLimit = rlMod.enforceRateLimit;
const phoneMod = await import('${phoneUrl}');
const normalizeUaPhoneDigits = phoneMod.normalizeUaPhoneDigits;
`;
  const tgStub = `const sendTelegramText = async (text: string) => {
  const gg = globalThis as RouteTestGlobal;
  (gg.__cbSends = gg.__cbSends ?? []).push(text);
  if (gg.__cbSendThrow) throw new Error('telegram down');
  return gg.__cbSendResult ?? { sent: true };
};`;
  const sbStub = `const createClient = (...args: unknown[]) => {
  const gg = globalThis as RouteTestGlobal;
  (gg.__cbClientCalls = gg.__cbClientCalls ?? []).push(args);
  if (gg.__cbClientThrow) throw new Error('client init failed');
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, value: unknown) {
              (gg.__cbQueriedProductId = value);
              return {
                async maybeSingle() {
                  const pid = gg.__cbQueriedProductId as string;
                  if (gg.__cbProductReadError) {
                    return { data: null, error: gg.__cbProductReadError };
                  }
                  const row = pid ? (gg.__cbProducts ?? {})[pid] : undefined;
                  return { data: row ?? null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
};`;

  const rewritten = src(ROUTE)
    .replace(
      /import\s*\{\s*enforceRateLimit\s*\}\s*from\s*'@\/app\/lib\/rate-limit';/,
      rlLoader
    )
    .replace(
      /import\s*\{\s*assertSameOrigin\s*\}\s*from\s*'@\/app\/lib\/request-origin';/,
      // Tests post without an Origin header — the real gate admits that
      // (see tests/csrf-origin.test.ts for the gate's own coverage).
      'const assertSameOrigin = (_request: unknown): boolean => true;'
    )
    .replace(
      /import\s*\{\s*normalizeUaPhoneDigits\s*\}\s*from\s*'@\/app\/lib\/phone';/,
      ''
    )
    .replace(
      /import\s*\{\s*sendTelegramText\s*\}\s*from\s*'@\/app\/lib\/notifications\/telegram';/,
      tgStub
    )
    .replace(
      /import\s*\{\s*createClient\s*\}\s*from\s*'@supabase\/supabase-js';/,
      sbStub
    );

  assert.ok(!rewritten.includes("'@supabase/supabase-js'"), 'harness drift: supabase not stubbed');
  assert.ok(!rewritten.includes("'@/app/lib/"), 'harness drift: @/ alias not stubbed');
  assert.ok(
    !rewritten.includes("'@/app/lib/notifications/telegram'"),
    'harness drift: telegram not stubbed'
  );
  const dir = mkdtempSync(path.join(tmpdir(), 'callback-route-'));
  try {
    const file = path.join(dir, 'route-stubbed.mts');
    writeFileSync(file, rewritten);
    return (await import(pathToFileURL(file).href)) as RouteModule;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

function postRequest(body: unknown, ip = '203.0.113.10'): Request {
  return new Request('https://example.com/api/products/callback-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

test('ROUTE: isCallbackUuid / isValidCallbackName (pure validators)', async () => {
  const { isCallbackUuid, isValidCallbackName } = await loadRoute();
  assert.equal(isCallbackUuid(UUID_A), true);
  assert.equal(isCallbackUuid(UUID_A.toUpperCase()), true, 'case-insensitive uuid');
  assert.equal(isCallbackUuid('not-a-uuid'), false);
  assert.equal(isCallbackUuid(42), false);
  assert.equal(isCallbackUuid(null), false);
  assert.equal(isValidCallbackName('Олександр'), true);
  assert.equal(isValidCallbackName('  Ал  '), true, 'trimmed by the caller');
  assert.equal(isValidCallbackName('А'), false, 'too short');
  assert.equal(isValidCallbackName(''), false);
  assert.equal(isValidCallbackName('x'.repeat(61)), false, 'over 60 chars rejected');
  assert.equal(isValidCallbackName('x'.repeat(60)), true);
});

test('ROUTE: valid request → 200 {ok:true}, ONE telegram send with name, E.164 phone, product', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  g.__cbProducts = { [UUID_A]: { name: 'Шпалери 6647-04', slug: 'shpaleri-6647-04' } };
  process.env.NEXT_PUBLIC_SITE_URL = 'https://towary-dla-domu.com';
  const res = await POST(
    postRequest({ productId: UUID_A, name: '  Олександр  ', phone: '097 123 45 67' })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await jsonBody(res), { ok: true });
  // service-role client, no session persistence
  assert.equal(g.__cbClientCalls!.length, 1);
  assert.deepEqual(g.__cbClientCalls![0]![2], { auth: { persistSession: false } });
  assert.equal(g.__cbSends!.length, 1);
  const message = g.__cbSends![0]!;
  assert.match(message, /📞 Передзвоніть мені/);
  assert.match(message, /Ім'я: Олександр/, 'name is trimmed');
  assert.match(message, /Телефон: \+380971234567/, 'separators tolerated → E.164');
  assert.match(message, /Товар: Шпалери 6647-04/);
  assert.match(message, /https:\/\/towary-dla-domu\.com\/product\/shpaleri-6647-04/);
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

test('ROUTE: pasted +380 / 380-prefix forms all normalize to the same E.164', async () => {
  const { POST } = await loadRoute();
  const forms = ['+380971234567', '380971234567', '0971234567', '971234567', '0 (97) 123-45-67'];
  let n = 0;
  for (const phone of forms) {
    resetRouteFakes();
    g.__cbProducts = { [UUID_A]: { name: 'n', slug: 's' } };
    const res = await POST(
      postRequest({ productId: UUID_A, name: 'Тест', phone }, `203.0.113.90.${n++}`)
    );
    assert.equal(res.status, 200, `form ${phone} must be accepted`);
    assert.match(g.__cbSends![0]!, /Телефон: \+380971234567/, `form ${phone} → E.164`);
  }
});

test('ROUTE: bad name → 400 «Вкажіть ваше ім\'я», ZERO DB/telegram activity', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  let n = 0;
  for (const name of ['', '   ', 'А', 'x'.repeat(61), 42, null, undefined]) {
    const res = await POST(
      postRequest(
        { productId: UUID_A, name: name as unknown as string, phone: '0971234567' },
        `203.0.113.70.${n++}`
      )
    );
    assert.equal(res.status, 400, `expected 400 for name=${String(name)}`);
    const json = await jsonBody(res);
    assert.deepEqual(Object.keys(json), ['error']);
    assert.equal(json.error, "Вкажіть ваше ім'я");
  }
  assert.equal(g.__cbClientCalls!.length, 0, 'name validation is DB-free');
  assert.equal(g.__cbSends!.length, 0);
});

test('ROUTE: bad phone → 400 «Некоректний номер телефону», ZERO DB/telegram activity', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  let n = 0;
  for (const phone of ['', '   ', '12345', '09712345678', 'abc', 42, null, undefined]) {
    const res = await POST(
      postRequest(
        { productId: UUID_A, name: 'Тест', phone: phone as unknown as string },
        `203.0.113.80.${n++}`
      )
    );
    assert.equal(res.status, 400, `expected 400 for phone=${String(phone)}`);
    const json = await jsonBody(res);
    assert.equal(json.error, 'Некоректний номер телефону');
  }
  assert.equal(g.__cbClientCalls!.length, 0);
  assert.equal(g.__cbSends!.length, 0);
  // Broken JSON body → 400 too.
  const broken = await POST(postRequest('{not json', '203.0.113.91'));
  assert.equal(broken.status, 400);
  assert.equal(g.__cbClientCalls!.length, 0);
});

test('ROUTE: honeypot filled → generic 200 {ok:true}, NO DB read, NO telegram', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  const res = await POST(
    postRequest({ productId: UUID_A, name: 'Бот', phone: '0971234567', website: 'http://spam.tld' })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await jsonBody(res), { ok: true });
  assert.equal(g.__cbClientCalls!.length, 0);
  assert.equal(g.__cbSends!.length, 0);
});

test('ROUTE: non-uuid productId → generic 200 {ok:true}, no read, no send (no oracle)', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  const res = await POST(
    postRequest({ productId: 'garbage', name: 'Тест', phone: '0971234567' })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await jsonBody(res), { ok: true });
  assert.equal(g.__cbClientCalls!.length, 0);
  assert.equal(g.__cbSends!.length, 0);
});

test('ROUTE: unknown product id → generic 200 {ok:true}, no send', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  g.__cbProducts = {}; // no such product
  const res = await POST(
    postRequest({ productId: UUID_A, name: 'Тест', phone: '0971234567' })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await jsonBody(res), { ok: true });
  assert.equal(g.__cbSends!.length, 0);
});

test('ROUTE: telegram failure or throw → 500 generic, no internals leaked', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  g.__cbProducts = { [UUID_A]: { name: 'n', slug: 's' } };

  g.__cbSendResult = { sent: false, reason: 'http_error' };
  let res = await POST(
    postRequest({ productId: UUID_A, name: 'Тест', phone: '0971234567' }, '203.0.113.60')
  );
  assert.equal(res.status, 500);
  const json = await jsonBody(res);
  assert.equal(json.error, 'Не вдалося надіслати запит. Спробуйте пізніше.');

  resetRouteFakes();
  g.__cbProducts = { [UUID_A]: { name: 'n', slug: 's' } };
  g.__cbSendThrow = true;
  res = await POST(
    postRequest({ productId: UUID_A, name: 'Тест', phone: '0971234567' }, '203.0.113.61')
  );
  assert.equal(res.status, 500, 'a telegram throw must resolve as a generic 500, never propagate');
  assert.ok(!JSON.stringify(await jsonBody(res)).includes('telegram down'));
});

test('ROUTE: DB read failure / client throw → 500 generic, no internals leaked', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  g.__cbProducts = { [UUID_A]: { name: 'n', slug: 's' } };
  g.__cbProductReadError = { message: 'permission denied for table products' };
  let res = await POST(
    postRequest({ productId: UUID_A, name: 'Тест', phone: '0971234567' }, '203.0.113.62')
  );
  assert.equal(res.status, 500);
  const json = await jsonBody(res);
  assert.equal(json.error, 'Не вдалося надіслати запит. Спробуйте пізніше.');
  assert.ok(!JSON.stringify(json).includes('permission denied'));

  resetRouteFakes();
  g.__cbClientThrow = true;
  res = await POST(
    postRequest({ productId: UUID_A, name: 'Тест', phone: '0971234567' }, '203.0.113.63')
  );
  assert.equal(res.status, 500);
});

test('ROUTE: rate limit — 3 accepted per IP per 10 min, 4th → 429 with Retry-After', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  g.__cbProducts = { [UUID_B]: { name: 'n', slug: 's' } };
  const ip = '198.51.100.77';
  for (let i = 0; i < 3; i++) {
    const res = await POST(
      postRequest({ productId: UUID_B, name: `Тест ${i}`, phone: '0971234567' }, ip)
    );
    assert.equal(res.status, 200, `request ${i + 1} must pass`);
  }
  const fourth = await POST(
    postRequest({ productId: UUID_B, name: 'Тест 4', phone: '0971234567' }, ip)
  );
  assert.equal(fourth.status, 429);
  assert.ok(fourth.headers.get('retry-after') !== null);
  assert.equal(g.__cbSends!.length, 3);
  // Another IP is unaffected.
  const other = await POST(
    postRequest({ productId: UUID_B, name: 'Інший', phone: '0971234567' }, '198.51.100.78')
  );
  assert.equal(other.status, 200);
});
