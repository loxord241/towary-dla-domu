/**
 * Store announcements (migration 031): admin-managed storefront notices.
 *
 * This module holds the PURE, isomorphic part of the domain: types,
 * constants, admin-payload validation and the storefront visibility
 * selector. It is imported by the 'use client' admin dashboard
 * (app/admin/(dashboard)/announcements/page.tsx), so it must stay free of
 * any server-only wiring — the Supabase read and its Data Cache live in
 * app/lib/announcements-store.ts (perf package 2026-09-13).
 *
 * Two consumers:
 *  - the storefront server component app/components/Announcements.tsx reads
 *    ACTIVE rows through the store module — the publishable-key anon client
 *    is used there and RLS allows SELECT of is_active rows only, so drafts
 *    never reach the client and the service role key must never be used;
 *  - the guarded admin route app/api/admin/announcements/route.ts reuses
 *    validateAnnouncementInput for create/edit payloads.
 *
 * Failure policy (store module): fetchActiveAnnouncements never throws —
 * an empty table, a network error or a misconfigured env must render an
 * empty banner, not break home/catalog/PDP/cart.
 */

export const ANNOUNCEMENT_TYPES = ['info', 'warning', 'important', 'success'] as const;

export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

export type Announcement = {
  id: string;
  title: string;
  message: string;
  type: AnnouncementType;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Human-readable type labels (admin UI + storefront aria text). */
export const ANNOUNCEMENT_TYPE_META: Record<AnnouncementType, { label: string }> = {
  info: { label: 'Інформація' },
  warning: { label: 'Попередження' },
  important: { label: 'Важливо' },
  success: { label: 'Успішно' },
};

export const ANNOUNCEMENT_TITLE_MAX = 200;
export const ANNOUNCEMENT_MESSAGE_MAX = 2000;

export type AnnouncementInput = {
  title: string;
  message: string;
  type: AnnouncementType;
  sortOrder: number;
};

export type AnnouncementValidation =
  | { ok: true; value: AnnouncementInput }
  | { ok: false };

function isAnnouncementType(value: unknown): value is AnnouncementType {
  return (
    typeof value === 'string' &&
    (ANNOUNCEMENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Validate an admin create/edit payload. Sort order is optional and falls
 * back to 0; anything malformed (unknown type, empty/oversized text,
 * non-numeric order) is rejected as a whole — no partial saves.
 */
export function validateAnnouncementInput(raw: unknown): AnnouncementValidation {
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const body = raw as Record<string, unknown>;

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length < 1 || title.length > ANNOUNCEMENT_TITLE_MAX) {
    return { ok: false };
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length < 1 || message.length > ANNOUNCEMENT_MESSAGE_MAX) {
    return { ok: false };
  }

  if (!isAnnouncementType(body.type)) return { ok: false };

  let sortOrder = 0;
  if (body.sortOrder !== undefined && body.sortOrder !== null) {
    const n = typeof body.sortOrder === 'number' ? body.sortOrder : NaN;
    if (!Number.isInteger(n) || n < 0 || n > 100_000) return { ok: false };
    sortOrder = n;
  }

  return { ok: true, value: { title, message, type: body.type, sortOrder } };
}

/**
 * Storefront visibility policy, pure and unit-tested: only active rows,
 * ordered by sort_order ascending (Array#sort is stable, so equal orders
 * keep their admin-listed sequence). Several active announcements always
 * render together; toggling one off never affects the others.
 */
export function selectActiveAnnouncements(rows: Announcement[]): Announcement[] {
  return rows
    .filter((r) => r.is_active)
    .sort((a, b) => a.sort_order - b.sort_order);
}
