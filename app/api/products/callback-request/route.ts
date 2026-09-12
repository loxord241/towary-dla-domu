import { createClient } from '@supabase/supabase-js';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { normalizeUaPhoneDigits } from '@/app/lib/phone';
import { sendTelegramText } from '@/app/lib/notifications/telegram';

/**
 * «Передзвоніть мені» — callback request endpoint (PDP, v1: owner-side
 * Telegram message with the customer's name + phone; NOTHING is persisted —
 * v1 has no table, the Telegram chat is the only record).
 *
 * Contract:
 *  - rate limit `callbackRequest` per IP (transient in-memory buckets —
 *    nothing persisted, see app/lib/rate-limit.ts): 3 / 10 min burst plus
 *    an 8 / hour ceiling — every ACCEPTED request pings the owner's
 *    Telegram directly, so it is tighter than restockNotify;
 *  - honeypot: a filled hidden `website` field is a bot — dropped with the
 *    SAME generic `200 { ok: true }` as success (no oracle, no send);
 *  - the two content 400s a real customer can fix: «Вкажіть ваше ім'я»
 *    (name < 2 or > 60 chars after trim) and «Некоректний номер телефону»
 *    (digit count is not one of the canonical UA forms 9/10/12, or the
 *    digits don't reduce to 9 national digits — normalizeUaPhoneDigits,
 *    the SAME normalizer the checkout form uses, behind a typo guard so a
 *    mangled number is rejected instead of silently truncated; sent to
 *    Telegram as E.164 +380XXXXXXXXX, matching /api/orders validation);
 *  - anti-enumeration: a non-uuid product id answers the SAME generic
 *    `200 { ok: true }` and performs NO read/send at all;
 *  - unknown product id → the same generic 200 with no send (mirrors
 *    restock-notify: no oracle about product existence);
 *  - the message is built ONLY from validated server-side data + the
 *    product row; plain text (no parse_mode), so the user-controlled name
 *    cannot break any formatting;
 *  - never-throw: client init, read and send failures all answer the same
 *    generic 500 «Не вдалося надіслати запит. Спробуйте пізніше.» — no
 *    internals (raw error text) ever reach the client;
 *  - a telegram send that resolves { sent: false } is ALSO a generic 500:
 *    with no table there is nowhere to queue the request, so success is
 *    never faked.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MIN = 2;
const NAME_MAX = 60;

const GENERIC_ERROR = 'Не вдалося надіслати запит. Спробуйте пізніше.';

export function isCallbackUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Format-only name check; trimming is the caller's. */
export function isValidCallbackName(value: string): boolean {
  return value.length >= NAME_MIN && value.length <= NAME_MAX;
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'callbackRequest');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Некоректні дані' }, { status: 400 });
  }
  const { productId, name, phone, website } = (body ?? {}) as {
    productId?: unknown;
    name?: unknown;
    phone?: unknown;
    website?: unknown;
  };

  // Honeypot: the hidden field must stay empty; bots that fill it are
  // dropped with the generic success — no oracle, no Telegram ping.
  if (typeof website === 'string' && website.length > 0) {
    return Response.json({ ok: true });
  }

  // Content errors FIRST (no DB touch on garbage input): the name and the
  // phone are the only mistakes a real customer needs to fix.
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!isValidCallbackName(trimmedName)) {
    return Response.json({ error: "Вкажіть ваше ім'я" }, { status: 400 });
  }
  const rawPhone = typeof phone === 'string' ? phone : '';
  // Typo guard before the truncating normalizer: the canonical UA forms
  // are 9 digits (national), 10 (leading 0) or 12 (+380/380 prefix) —
  // anything else is a mangled number, NOT silently truncated to a wrong
  // one (normalizeUaPhoneDigits keeps the FIRST 9 national digits).
  const digitCount = rawPhone.replace(/\D/g, '').length;
  if (digitCount !== 9 && digitCount !== 10 && digitCount !== 12) {
    return Response.json(
      { error: 'Некоректний номер телефону' },
      { status: 400 }
    );
  }
  const nationalDigits = normalizeUaPhoneDigits(rawPhone);
  if (nationalDigits.length !== 9) {
    return Response.json(
      { error: 'Некоректний номер телефону' },
      { status: 400 }
    );
  }
  const e164 = `+380${nationalDigits}`;

  // Anti-enumeration: a non-uuid product id answers the same generic 200
  // and performs NO read/send at all.
  if (!isCallbackUuid(productId)) {
    return Response.json({ ok: true });
  }

  // Every failure below — client init, read, send — answers the same
  // generic 500; no internals (raw error text) ever reach the client.
  try {
    const sb = serviceClient();

    const { data, error: readError } = await sb
      .from('products')
      .select('id,name,slug')
      .eq('id', productId)
      .maybeSingle();
    if (readError) {
      return Response.json({ error: GENERIC_ERROR }, { status: 500 });
    }
    // Unknown id → generic success, NO send (no oracle).
    if (!data) {
      return Response.json({ ok: true });
    }

    const product = data as { name?: unknown; slug?: unknown };
    const productName =
      typeof product.name === 'string' ? product.name.slice(0, 160) : '';
    const slug = typeof product.slug === 'string' ? product.slug : '';
    const productUrl =
      slug !== '' && process.env.NEXT_PUBLIC_SITE_URL
        ? `\n${process.env.NEXT_PUBLIC_SITE_URL}/product/${slug}`
        : '';

    const result = await sendTelegramText(
      `📞 Передзвоніть мені\nІм'я: ${trimmedName}\nТелефон: ${e164}\nТовар: ${productName}${productUrl}`
    );
    if (!result.sent) {
      // Nothing is persisted (v1 has no table) — an undelivered request is
      // an honest failure the customer can retry.
      return Response.json({ error: GENERIC_ERROR }, { status: 500 });
    }

    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
