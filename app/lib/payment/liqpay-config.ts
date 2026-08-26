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

/** Throws when the integration is not configured (server boot/misconfig). */
export function getLiqPayConfig(): LiqPayConfig {
  return {
    publicKey: readKey('LIQPAY_PUBLIC_KEY'),
    privateKey: readKey('LIQPAY_PRIVATE_KEY'),
    sandbox: process.env.LIQPAY_SANDBOX === '1',
  };
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
