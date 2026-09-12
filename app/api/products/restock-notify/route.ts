import { createClient } from '@supabase/supabase-js';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { assertSameOrigin } from '@/app/lib/request-origin';

/**
 * «Повідомити про наявність» — restock request endpoint (v1: owner-side
 * Telegram digest; no customer email is ever sent from here).
 *
 * Contract (anti-enumeration by design):
 *  - valid email, but UNKNOWN product id / existing-but-NOT-out-of-stock
 *    product / duplicate (product_id, email) → the SAME generic
 *    `200 { ok: true }`: no oracle about product existence or stock state,
 *    nothing is written in the non-OOS cases;
 *  - the ONLY 400 is a malformed email (`Некоректний email`) — a cheap,
 *    DB-free validation a real customer needs to fix a typo;
 *  - rate limit 5 / 10 min per IP (transient in-memory buckets — nothing
 *    persisted, see app/lib/rate-limit.ts);
 *  - the `restock_requests` table (migration 042) is written EXCLUSIVELY
 *    here via the service-role key; SELECT/INSERT are revoked from
 *    anon/authenticated in the migration (RLS on top), so this endpoint is
 *    the single door;
 *  - duplicates collapse through ON CONFLICT DO NOTHING
 *    (upsert + ignoreDuplicates over UNIQUE (product_id, email)) and still
 *    answer 200 { ok: true };
 *  - DB failure → 500 `Не вдалося зберегти запит. Спробуйте пізніше.` with
 *    no internals (raw error.message never reaches the client);
 *  - emails are normalized (trim + lowercase) before storage so the UNIQUE
 *    pair dedupes case-insensitively (TEXT column, no citext needed).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** RFC 5321 forwarding-path practical maximum. */
const EMAIL_MAX_LENGTH = 254;

export function isRestockUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Format-only email check; normalization (trim+lowercase) is the caller's. */
export function isValidRestockEmail(value: string): boolean {
  return value.length > 0 && value.length <= EMAIL_MAX_LENGTH && EMAIL_RE.test(value);
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'restockNotify');
  if (limited) return limited;

  // Same-origin gate (audit P1): a cross-site browser POST always carries
  // an Origin that cannot match the deployment host — reject before any
  // parse/DB work (see app/lib/request-origin.ts).
  if (!assertSameOrigin(request)) {
    return Response.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Некоректний email' }, { status: 400 });
  }
  const { productId, email } = (body ?? {}) as {
    productId?: unknown;
    email?: unknown;
  };

  // Email is validated FIRST (no DB touch on garbage input); a malformed
  // address is the only content error the client can learn about.
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!isValidRestockEmail(normalized)) {
    return Response.json({ error: 'Некоректний email' }, { status: 400 });
  }

  // Anti-enumeration: a non-uuid product id answers the same generic 200
  // and performs NO read/write at all.
  if (!isRestockUuid(productId)) {
    return Response.json({ ok: true });
  }

  // Every storage failure below — client init, read, write — answers the
  // same generic 500; no internals (raw error text) ever reach the client.
  try {
    const sb = serviceClient();

    const { data, error: readError } = await sb
      .from('products')
      .select('id,availability_status')
      .eq('id', productId)
      .maybeSingle();
    if (readError) {
      return Response.json(
        { error: 'Не вдалося зберегти запит. Спробуйте пізніше.' },
        { status: 500 }
      );
    }
    // Unknown id or not out-of-stock → generic success, NO insert (no oracle,
    // and requests never accumulate for in-stock positions).
    if (!data || data.availability_status !== 'out_of_stock') {
      return Response.json({ ok: true });
    }

    // Repeated requests from the same customer for the same product are a
    // silent no-op (UNIQUE (product_id, email), migration 042): upsert with
    // ignoreDuplicates resolves to INSERT ... ON CONFLICT (product_id, email)
    // DO NOTHING.
    const { error } = await sb
      .from('restock_requests')
      .upsert(
        { product_id: productId, email: normalized },
        { onConflict: 'product_id,email', ignoreDuplicates: true }
      );
    if (error) {
      return Response.json(
        { error: 'Не вдалося зберегти запит. Спробуйте пізніше.' },
        { status: 500 }
      );
    }

    return Response.json({ ok: true });
  } catch {
    return Response.json(
      { error: 'Не вдалося зберегти запит. Спробуйте пізніше.' },
      { status: 500 }
    );
  }
}
