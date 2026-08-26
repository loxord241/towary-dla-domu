/**
 * PRE-LIVE payload check for the LiqPay production switch. STRICTLY local:
 * builds a checkout payload in-memory and verifies its shape — NO network
 * call to LiqPay, NO DB writes, NO order creation, NO payment.
 *
 *   node scripts/tmp-liqpay-payload-check.ts
 *
 * Reads LIQPAY_* from .env.local (the same values that must be set in
 * Vercel). Amount/currency are taken from an EXISTING orders row via the
 * service key (read-only SELECT) to mirror the real init path, which reads
 * money exclusively from the DB.
 *
 * Exits non-zero on any failure.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^"|"$/g, '').trim();
    }
  }
} catch {}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 1. config loads and passes the sandbox/live cross-check
const { getLiqPayConfig } = await import('../app/lib/payment/liqpay-config.ts');
let cfg: Awaited<ReturnType<typeof getLiqPayConfig>>;
try {
  cfg = getLiqPayConfig();
  check('config consistent with cross-check guard', true);
} catch (e) {
  check('config consistent with cross-check guard', false, String(e));
  process.exit(1);
}
check(
  'sandbox flag state',
  process.env.LIQPAY_SANDBOX === '0' ? cfg.sandbox === false : cfg.sandbox === true,
  `LIQPAY_SANDBOX=${process.env.LIQPAY_SANDBOX ?? '(unset)'} → sandbox=${cfg.sandbox}`
);
check(
  'public key mode matches flag (no sandbox_ prefix expected in live mode)',
  cfg.sandbox ? cfg.publicKey.startsWith('sandbox_') : !cfg.publicKey.startsWith('sandbox_'),
  `key length=${cfg.publicKey.length} (value not printed)`
);

// 2. take amount/currency from a REAL existing order row (read-only)
const { createClient } = await import('@supabase/supabase-js');
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const { data: orderRow, error } = await svc
  .from('orders')
  .select('order_number,total_amount,currency')
  .limit(1)
  .maybeSingle();
check('read existing order for money fields', !!orderRow && !error, error?.message);
if (!orderRow) {
  console.log(`\nRESULT: PASS=${pass} FAIL=${++fail}`);
  process.exit(1);
}
const order = orderRow as { order_number: string; total_amount: number | string; currency: string };

// 3. build the exact production payload shape via the shipped builder
const { buildCheckoutPayload } = await import('../app/lib/payment/order-payment-update.ts');
const { encodeLiqPayData, createLiqPaySignature } = await import(
  '../app/lib/payment/liqpay-signature.ts'
);
const SITE =
  (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '') ||
  'http://localhost:3000';

const payload = buildCheckoutPayload({
  config: cfg,
  orderIdWithAttempt: String(order.order_number),
  baseOrderNumber: String(order.order_number),
  amount: order.total_amount,
  currency: String(order.currency),
  resultUrl: `${SITE}/checkout/success?order=${encodeURIComponent(String(order.order_number))}&t=PRELIVE-CHECK`,
  callbackUrl: `${SITE}/api/payment/liqpay/callback`,
});

check('version is JSON number 3', typeof payload.version === 'number' && payload.version === 3);
check('action = pay', payload.action === 'pay');
check('public_key = configured key', payload.public_key === cfg.publicKey);
check(
  'amount sourced from the DB row',
  payload.amount === Number(order.total_amount).toFixed(2),
  `${payload.amount} (orders.total_amount=${order.total_amount})`
);
check('currency sourced from the DB row', payload.currency === order.currency);
check('language uk present', payload.language === 'uk');

if (cfg.sandbox) {
  check('sandbox payload carries sandbox="1"', payload.sandbox === '1');
} else {
  check('NO sandbox field in live payload', !('sandbox' in payload));
}

// 4. signature reproduces from the private key over the encoded data
const data = encodeLiqPayData(payload);
const sig = createLiqPaySignature(data, cfg.privateKey);
check('signature format (base64 SHA-1 digest)', /^[A-Za-z0-9+/]+={0,2}$/.test(sig));
const reencoded = encodeLiqPayData(JSON.parse(Buffer.from(data, 'base64').toString('utf8')));
check('data round-trips through decode/re-encode', reencoded === data);
check('signature deterministic across rebuilds', createLiqPaySignature(data, cfg.privateKey) === sig);

// 5. URLs
const cb = `${SITE}/api/payment/liqpay/callback`;
const rs = `${SITE}/checkout/success?order=${encodeURIComponent(String(order.order_number))}&t=PRELIVE-CHECK`;
check('server_url = HTTPS production callback', payload.server_url === cb && cb.startsWith('https://'), String(payload.server_url));
check('result_url = HTTPS success page', payload.result_url === rs && rs.startsWith('https://'), String(payload.result_url));

// 6. secrets isolation in client bundle (local build output)
{
  const { readdirSync, statSync } = await import('node:fs');
  const chunksDir = path.join(root, '.next/static');
  const leaks: string[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.js$/.test(name)) {
        const content = readFileSync(full, 'utf8');
        if (
          content.includes(cfg.privateKey) ||
          /LIQPAY_PRIVATE_KEY|SUPABASE_SERVICE_ROLE_KEY/.test(content)
        ) {
          leaks.push(path.relative(root, full));
        }
      }
    }
  };
  walk(chunksDir);
  check('client bundle contains no private key/service secret references', leaks.length === 0, leaks.join(', ') || 'scanned all .next/static/*.js');
}

console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
