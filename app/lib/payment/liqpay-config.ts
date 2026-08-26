/**
 * Server-side LiqPay configuration.
 *
 * IMPORTANT: this module is imported ONLY by route handlers and server
 * components. The private key lives exclusively in LIQPAY_PRIVATE_KEY env
 * (never in NEXT_PUBLIC_*, never in the DB, never in a client component).
 *
 * There is no sandbox-vs-live API base difference for LiqPay: the checkout
 * URL is always https://www.liqpay.ua/api/3/checkout — sandbox mode is
 * signaled per-payment via the payload's "sandbox" field.
 */

export const LIQPAY_CHECKOUT_URL = 'https://www.liqpay.ua/api/3/checkout';

export interface LiqPayConfig {
  publicKey: string;
  privateKey: string;
  sandbox: boolean;
}

function readKey(name: 'LIQPAY_PUBLIC_KEY' | 'LIQPAY_PRIVATE_KEY'): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`LIQPAY_NOT_CONFIGURED: ${name} is not set`);
  }
  return v;
}

/**
 * LiqPay (PrivatBank) documents its sandbox keys with a literal `sandbox_`
 * prefix on the PUBLIC key (e.g. `sandbox_i33111011000`), while live public
 * keys have none (`i33111011000`). The prefix is a property of the public
 * key — it is meant to be exposed — so this check carries no secret risk.
 * The private key has no such marker; it is never inspected.
 */
const LIQPAY_SANDBOX_KEY_PREFIX = 'sandbox_';

export type LiqPayKeyMode = 'sandbox' | 'live';

export function detectLiqPayKeyMode(publicKey: string): LiqPayKeyMode {
  return publicKey.startsWith(LIQPAY_SANDBOX_KEY_PREFIX) ? 'sandbox' : 'live';
}

/** Throws when the integration is not configured (server boot/misconfig). */
export function getLiqPayConfig(): LiqPayConfig {
  const publicKey = readKey('LIQPAY_PUBLIC_KEY');
  const privateKey = readKey('LIQPAY_PRIVATE_KEY');
  const sandbox = process.env.LIQPAY_SANDBOX === '1';

  // Cross-check: the sandbox flag and the key mode must agree. A mismatch
  // means real money could be routed through test settings (or vice versa)
  // without anyone noticing. Errors name only the env vars involved — the
  // message must never contain key material.
  const keyMode = detectLiqPayKeyMode(publicKey);
  if (sandbox && keyMode !== 'sandbox') {
    throw new Error(
      'LIQPAY_CONFIG_MISMATCH: LIQPAY_SANDBOX=1 but LIQPAY_PUBLIC_KEY is a live-type key ' +
        '(sandbox mode requires the sandbox_-prefixed test key pair)'
    );
  }
  if (!sandbox && keyMode === 'sandbox') {
    throw new Error(
      'LIQPAY_CONFIG_MISMATCH: LIQPAY_PUBLIC_KEY is a sandbox_-prefixed test key but ' +
        "LIQPAY_SANDBOX != '1' (set it explicitly, or switch to the live key pair)"
    );
  }

  return { publicKey, privateKey, sandbox };
}

/** Non-throwing availability probe (used to decide whether to show pay UI). */
export function isLiqPayConfigured(): boolean {
  try {
    getLiqPayConfig();
    return true;
  } catch {
    return false;
  }
}

function siteUrlBase(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(
    /\/+$/,
    ''
  );
}

/** Absolute URL LiqPay's server calls back with data/signature. */
export function buildCallbackUrl(): string {
  return `${siteUrlBase()}/api/payment/liqpay/callback`;
}

/**
 * result_url the browser returns to after checkout. NEVER trusted by the
 * server as payment truth — it only carries the capability pair that the
 * success page already verifies.
 */
export function buildResultUrl(orderNumber: string, token: string): string {
  return `${siteUrlBase()}/checkout/success?order=${encodeURIComponent(
    orderNumber
  )}&t=${encodeURIComponent(token)}`;
}
