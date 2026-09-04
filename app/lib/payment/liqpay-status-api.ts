/**
 * Shared server-side LiqPay Status API client (action=status — READ ONLY).
 *
 * Single implementation used by BOTH scripts/reconcile-liqpay.mts and the
 * admin reconciliation endpoint. It reuses the production-verified signing
 * primitives from liqpay-signature.ts and NEVER reimplements crypto, logs,
 * or exposes key material.
 *
 * Contract (verified in production, see tmp-verify-live-payment.ts):
 *   POST https://www.liqpay.ua/api/request
 *   body: data=base64(JSON), signature=base64(sha1(priv+data+priv))
 *   payload: { action:'status', version:3, public_key, order_id }
 *
 * Return values:
 *   - parsed provider JSON object on any HTTP 200 answer (including
 *     result="error" bodies with machine codes such as payment_not_found);
 *   - null when the exchange cannot be trusted at all (network failure,
 *     non-200, unparsable body) — callers classify this as UNREACHABLE.
 */

import { encodeLiqPayData, createLiqPaySignature } from './liqpay-signature.ts';

const LIQPAY_REQUEST_URL = 'https://www.liqpay.ua/api/request';

export async function fetchLiqPayProviderStatus(
  liqpayOrderId: string,
  publicKey: string,
  privateKey: string
): Promise<Record<string, unknown> | null> {
  try {
    const data = encodeLiqPayData({
      action: 'status', // READ — no other action is ever sent here
      version: 3,
      public_key: publicKey,
      order_id: liqpayOrderId,
    });
    const signature = createLiqPaySignature(data, privateKey);
    const res = await fetch(LIQPAY_REQUEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data, signature }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
