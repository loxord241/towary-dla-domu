import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { storagePathFromImageUrl } from './supabase-storage';

export type AdminApiContext = {
  userId: string;
  email: string;
  /** Service-role client — safe to use only AFTER the guard passed. */
  serviceClient: SupabaseClient;
};

/**
 * Single server-side entry guard for every /api/admin/* route handler.
 *
 * 1. Resolves the caller identity with getUser() (validates the JWT,
 *    unlike getSession() which trusts raw cookies).
 * 2. Verifies the email exists in the admin_users table.
 * 3. Only then exposes a service-role client for privileged operations.
 *
 * Usage:
 *   const ctx = await requireAdminApi();
 *   if (ctx instanceof NextResponse) return ctx;
 */
export async function requireAdminApi(): Promise<AdminApiContext | NextResponse> {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Cookie writes are allowed in Route Handlers;
            // kept defensive to mirror the SSR pattern.
          }
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Service role key stays server-side only; it is never returned
  // to the caller nor imported into any client bundle.
  const serviceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Case-insensitive match: Supabase Auth lowercases emails in tokens,
  // but rows in admin_users may have been written with mixed case.
  const { data: adminRow, error } = await serviceClient
    .from('admin_users')
    .select('email')
    .ilike('email', user.email)
    .maybeSingle();

  if (error || !adminRow) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return { userId: user.id, email: user.email, serviceClient };
}

/** Convert unknown JSON value into TEXT column value (null when empty). */
export function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Convert unknown JSON value into a UUID-or-null foreign key value. */
export function uuidOrNull(value: unknown): string | null {
  const v = strOrNull(value);
  return v && isUuid(v) ? v : null;
}

/** Check whether a route parameter is a well-formed UUID. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );
}

/** Convert unknown JSON value into a finite number-or-null. */
export function numOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Convert unknown JSON value into a finite non-negative number-or-null. */
export function nonNegNumOrNull(value: unknown): number | null {
  const n = numOrNull(value);
  return n !== null && n >= 0 ? n : null;
}

/**
 * Map a PostgREST error onto an HTTP error response.
 * Unique-constraint violations become 409, FK violations become 400,
 * anything else becomes a generic 500 — the raw database message is logged
 * server-side only, never returned to the client.
 */
export function dbErrorResponse(
  error: { message?: string; code?: string | null } | null | undefined,
  fallbackMessage: string
): NextResponse {
  if (!error) {
    console.error('dbErrorResponse: unknown DB failure:', fallbackMessage);
    return NextResponse.json({ error: fallbackMessage }, { status: 500 });
  }
  if (error.code === '23505') {
    return NextResponse.json(
      { error: 'Запис з таким унікальним значенням вже існує (SKU/slug)' },
      { status: 409 }
    );
  }
  if (error.code === '23503') {
    return NextResponse.json(
      { error: "Пов'язаний запис не існує або на нього є посилання" },
      { status: 400 }
    );
  }
  // Unmapped codes: internals (table/column/constraint names) must not leak.
  console.error(
    `dbErrorResponse [${error.code ?? 'no-code'}]: ${error.message ?? 'no message'}`
  );
  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

/**
 * Normalize a product_images.image_url value into a storage object path.
 * Delegates to the pure, dependency-free implementation in
 * supabase-storage.ts (external URLs → '' so delete flows skip Storage).
 */
export function toStoragePath(imageUrl: string): string {
  return storagePathFromImageUrl(imageUrl);
}
