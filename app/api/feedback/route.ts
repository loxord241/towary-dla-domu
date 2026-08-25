import { createClient } from '@supabase/supabase-js';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import {
  validateFeedbackMessage,
  FEEDBACK_DAILY_CAP,
} from '@/app/lib/feedback';

/**
 * Anonymous feedback endpoint.
 *
 * Anonymity contract: the ONLY accepted datum is the message text. The
 * per-IP sliding window below runs in transient process memory and never
 * persists anything; the shared daily flood cap counts table rows by
 * created_at — no identifier is stored anywhere.
 *
 * Storage: the `feedback` table (database/migrations/013_feedback.sql) is
 * written exclusively here via the service-role key. Until that migration
 * has been applied to the environment, inserts fail and the route answers
 * 503 `feedback_storage_not_configured` so the UI shows an honest state —
 * success is never faked.
 */

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(request: Request) {
  // Layer 1: per-IP burst protection — transient, in-memory, nothing stored.
  const limited = enforceRateLimit(request, 'feedback');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { message, website } = (body ?? {}) as {
    message?: unknown;
    website?: unknown;
  };

  // Honeypot: the hidden field must stay empty; bots that fill it are
  // dropped without any processing.
  if (typeof website === 'string' && website.length > 0) {
    return Response.json({ error: 'feedback_storage_not_configured' }, { status: 503 });
  }

  const validated = validateFeedbackMessage(message);
  if (!validated.ok) {
    return Response.json({ error: 'invalid_message' }, { status: 400 });
  }

  const sb = serviceClient();

  // Layer 2: shared daily cap — works across instances, keyed by nothing
  // user-specific (a plain count of today's rows).
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await sb
    .from('feedback')
    .select('*', { count: 'exact', head: true })
    .gt('created_at', dayAgo);
  if ((count ?? 0) >= FEEDBACK_DAILY_CAP) {
    return Response.json({ error: 'feedback_rate_limited' }, { status: 429 });
  }

  const { error } = await sb.from('feedback').insert({ message: validated.text });
  if (error) {
    // Migration not applied yet (or a storage hiccup) — degrade honestly.
    return Response.json({ error: 'feedback_storage_not_configured' }, { status: 503 });
  }

  return Response.json({ ok: true }, { status: 201 });
}
