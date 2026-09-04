/**
 * Store announcements — storefront selector, validation and wiring invariants.
 *
 * Behaviour contract:
 *  - selectActiveAnnouncements: returns ONLY active rows, ordered by
 *    sort_order ascending (stable); several active announcements coexist;
 *  - validateAnnouncementInput: admin payloads are trimmed, length-capped
 *    and restricted to the four agreed types;
 *  - fetchActiveAnnouncements never throws — an empty/broken table must
 *    not break any storefront page;
 *  - the storefront lib uses the publishable key only (RLS decides
 *    visibility); admin CRUD sits behind requireAdminApi;
 *  - the banner is a server-rendered content block mounted on home,
 *    catalog, PDP and cart — never on checkout — and must not overlay
 *    navigation or content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// announcements.ts creates its Supabase client at module load; provide the
// publishable-env placeholders BEFORE the import (no network happens) —
// same pattern as tests/catalog-search.test.ts.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';

const {
  ANNOUNCEMENT_TYPES,
  ANNOUNCEMENT_TYPE_META,
  selectActiveAnnouncements,
  validateAnnouncementInput,
} = await import('../app/lib/announcements.ts');

type Announcement = import('../app/lib/announcements.ts').Announcement;

function row(overrides: Partial<Announcement>): Announcement {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: 'Заголовок',
    message: 'Текст повідомлення.',
    type: 'info',
    is_active: true,
    sort_order: 0,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

// ---- types ----

test('ANN-TYPES: exactly info|warning|important|success are supported', () => {
  assert.deepEqual([...ANNOUNCEMENT_TYPES].sort(), [
    'important',
    'info',
    'success',
    'warning',
  ]);
});

test('ANN-TYPES: every type has an admin/storefront label', () => {
  for (const t of ANNOUNCEMENT_TYPES) {
    assert.ok(
      ANNOUNCEMENT_TYPE_META[t]?.label?.length > 0,
      `missing label for ${t}`
    );
  }
});

// ---- selectActiveAnnouncements ----

test('ANN-SELECT: inactive announcements are never returned', () => {
  const rows = [
    row({ id: 'a', is_active: true }),
    row({ id: 'b', is_active: false }),
  ];
  const out = selectActiveAnnouncements(rows);
  assert.deepEqual(out.map((r) => r.id), ['a']);
});

test('ANN-SELECT: several active announcements are returned together in sort_order', () => {
  const rows = [
    row({ id: 'w3', type: 'warning', sort_order: 30 }),
    row({ id: 'w1', type: 'warning', sort_order: 10 }),
    row({ id: 'i2', type: 'info', sort_order: 20 }),
  ];
  const out = selectActiveAnnouncements(rows);
  assert.deepEqual(out.map((r) => r.id), ['w1', 'i2', 'w3']);
});

test('ANN-SELECT: empty list returns empty array (storefront stays intact)', () => {
  assert.deepEqual(selectActiveAnnouncements([]), []);
});

test('ANN-SELECT: mixed active/inactive keeps only active ones ordered', () => {
  const rows = [
    row({ id: 'w1', type: 'warning', sort_order: 10, is_active: true }),
    row({ id: 'i2', type: 'info', sort_order: 20, is_active: true }),
    row({ id: 'w3', type: 'warning', sort_order: 30, is_active: true }),
    row({ id: 'off', type: 'important', sort_order: 5, is_active: false }),
  ];
  const out = selectActiveAnnouncements(rows);
  assert.deepEqual(out.map((r) => r.id), ['w1', 'i2', 'w3']);
});

// ---- validateAnnouncementInput ----

test('ANN-VALIDATE: accepts a trimmed valid payload', () => {
  const res = validateAnnouncementInput({
    title: '  Заголовок  ',
    message: ' Текст. ',
    type: 'warning',
    sortOrder: 7,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.title, 'Заголовок');
    assert.equal(res.value.message, 'Текст.');
    assert.equal(res.value.type, 'warning');
    assert.equal(res.value.sortOrder, 7);
  }
});

test('ANN-VALIDATE: rejects empty/oversized title and message', () => {
  assert.equal(validateAnnouncementInput({ title: '   ', message: 'Текст.', type: 'info' }).ok, false);
  assert.equal(
    validateAnnouncementInput({ title: 'x'.repeat(201), message: 'Текст.', type: 'info' }).ok,
    false
  );
  assert.equal(validateAnnouncementInput({ title: 'Заголовок', message: '', type: 'info' }).ok, false);
  assert.equal(
    validateAnnouncementInput({ title: 'Заголовок', message: 'x'.repeat(2001), type: 'info' }).ok,
    false
  );
});

test('ANN-VALIDATE: rejects unknown types and non-object payloads', () => {
  assert.equal(validateAnnouncementInput({ title: 'A', message: 'B', type: 'critical' }).ok, false);
  assert.equal(validateAnnouncementInput({ title: 'A', message: 'B' }).ok, false);
  assert.equal(validateAnnouncementInput(null).ok, false);
  assert.equal(validateAnnouncementInput('text').ok, false);
});

test('ANN-VALIDATE: sortOrder falls back to 0 and rejects garbage', () => {
  const ok = validateAnnouncementInput({ title: 'A', message: 'B', type: 'info' });
  assert.ok(ok.ok && ok.value.sortOrder === 0);
  assert.equal(
    validateAnnouncementInput({ title: 'A', message: 'B', type: 'info', sortOrder: 'many' }).ok,
    false
  );
});

// ---- storefront lib: security ----

test('ANN-LIB: storefront reads use the publishable key only', () => {
  const lib = src('app/lib/announcements.ts');
  assert.match(lib, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(lib, /SERVICE_ROLE/);
});

test('ANN-LIB: fetchActiveAnnouncements filters is_active and orders by sort_order', () => {
  const lib = src('app/lib/announcements.ts');
  assert.match(lib, /is_active[^\n]*true|eq\('is_active',\s*true\)/);
  assert.match(lib, /sort_order/);
});

test('ANN-LIB: SSR read carries a deadline — hung upstream never stalls the page (2026-09-04)', () => {
  const lib = src('app/lib/announcements.ts');
  // supabase-js queries take no AbortSignal, so the deadline is a race
  // against a timer; the timeout path stays fail-open ([]) and logs.
  assert.match(lib, /ANNOUNCEMENTS_DEADLINE_MS = 8_000/);
  assert.match(lib, /Promise\.race\(\[query, deadline\]\)/);
  assert.match(lib, /console\.error\('store announcements: deadline exceeded/);
  assert.match(lib, /return \[\];/, 'fail-open contract preserved');
});

// ---- admin route: guard ----

test('ANN-ADMIN-API: every handler sits behind requireAdminApi', () => {
  const route = src('app/api/admin/announcements/route.ts');
  for (const handler of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const body = route.match(
      new RegExp(`export\\s+async\\s+function\\s+${handler}\\s*\\([\\s\\S]*?\\n\\}`, 'm')
    );
    assert.ok(body, `handler ${handler} missing`);
    assert.match(body[0], /requireAdminApi/, `${handler} must call requireAdminApi`);
    assert.match(
      body[0],
      /instanceof\s+NextResponse/,
      `${handler} must bail out when the guard rejects`
    );
  }
  // No direct service-role client creation inside the route — the guarded
  // ctx.serviceClient is the only privileged path.
  assert.doesNotMatch(route, /createClient\(/);
});

test('ANN-ADMIN-API: PATCH toggle only touches is_active for toggle payloads', () => {
  const route = src('app/api/admin/announcements/route.ts');
  assert.match(route, /is_active/);
  assert.match(route, /updated_at/);
});

// ---- storefront component wiring ----

test('ANN-UI: banner is a server component that never overlays content', () => {
  const banner = src('app/components/Announcements.tsx');
  assert.doesNotMatch(banner, /'use client'/);
  assert.doesNotMatch(banner, /position:\s*fixed|"fixed\s|className="[^"]*\bfixed\b/);
  assert.match(banner, /fetchActiveAnnouncements/);
  assert.match(banner, /role="region"|aria-label/);
});

test('ANN-UI: announcement is a compact strip with a type-colored left accent', () => {
  const banner = src('app/components/Announcements.tsx');
  // Compact strip: thin border, design-system rounding, small left accent.
  assert.match(banner, /rounded-lg/, 'compact rounding missing');
  assert.match(banner, /border-l-2/, 'left accent bar missing');
  assert.doesNotMatch(banner, /shadow-md/, 'strips must stay visually light');
  // Every type defines its own border + accent + very light tint.
  for (const t of ANNOUNCEMENT_TYPES) {
    const entry = banner.slice(banner.indexOf(`${t}:`));
    assert.match(entry, /border-/, `type '${t}' has no border color`);
    assert.match(entry, /bg-/, `type '${t}' has no tinted background`);
  }
  // Accent, not fill: tints are semi-transparent so color stays an accent.
  assert.match(banner, /bg-\w+-\d+\/\d+/, 'background tint must be very light');
});

test('ANN-UI: warning is ORANGE, not amber — must stand out from the page background and from info-blue', () => {
  const banner = src('app/components/Announcements.tsx');
  const entry = banner.slice(
    banner.indexOf('warning: {'),
    banner.indexOf('important: {')
  );
  assert.match(entry, /orange-/, 'warning must use the orange family');
  assert.doesNotMatch(entry, /amber-/, 'amber blends with the background — do not use it');
});

test('ANN-UI: desktop strip is single-line [icon] title · message', () => {
  const banner = src('app/components/Announcements.tsx');
  // Inline composition with a separator dot on desktop; message drops to
  // its own line on mobile.
  assert.match(banner, /block[^"']*sm:inline/, 'mobile wrap missing');
  assert.match(banner, /announcement\.title/);
  assert.match(banner, /announcement\.message/);
  for (const t of ANNOUNCEMENT_TYPES) {
    assert.ok(banner.includes(`${t}:`), `type '${t}' has no visual style`);
  }
});

test('ANN-UI: no large announcement label — strip stays quiet', () => {
  const banner = src('app/components/Announcements.tsx');
  assert.ok(
    !banner.includes('Оголошення'),
    'visible eyebrow label must be removed for the compact strip'
  );
});

test('ANN-UI: icon sits in a small circular container', () => {
  const banner = src('app/components/Announcements.tsx');
  assert.match(banner, /rounded-full/, 'icon circle container missing');
  assert.match(banner, /h-6 w-6|h-7 w-7/, 'icon container must stay small');
});

test('ANN-UI: multiple announcements stack as compact strips', () => {
  const banner = src('app/components/Announcements.tsx');
  assert.match(banner, /space-y-2/, 'small gap between strips missing');
  assert.match(banner, /min-w-0/, 'long Ukrainian texts must wrap inside the strip');
});

test('ANN-UI: geometry is centered fit-content, NOT full container width', () => {
  const banner = src('app/components/Announcements.tsx');
  // Desktop: the visual strip shrink-wraps its content and is centered.
  assert.match(banner, /w-full\s+sm:w-fit/, 'strip must be w-fit on desktop');
  assert.match(banner, /max-w-\[\d+px\]/, 'desktop max-width cap missing');
  assert.match(banner, /mx-auto/, 'strip must be centered');
  // Mobile: near-full width (long text must fit), via a slim px-3 wrapper
  // = calc(100% - 24px), not the wide container gutter.
  assert.match(banner, /px-3/, 'slim mobile gutter missing');
  // No shadow: notification badge, not an alert banner.
  assert.doesNotMatch(banner, /shadow-/, 'strip must have no shadow');
});

test('ANN-UI: mounted on home, catalog and PDP', () => {
  for (const page of ['app/(home)/page.tsx', 'app/catalog/page.tsx', 'app/product/[slug]/page.tsx']) {
    const s = src(page);
    assert.match(s, /Announcements/, `${page} must render the banner`);
    assert.match(s, /<Announcements\s*\/>/, `${page} must render <Announcements />`);
  }
});

test('ANN-UI: mounted on cart, absent from checkout', () => {
  const cartLayout = src('app/cart/layout.tsx');
  assert.match(cartLayout, /<Announcements\s*\/>/);
  const checkoutLayout = src('app/checkout/layout.tsx');
  assert.doesNotMatch(checkoutLayout, /Announcements/);
  const checkoutForm = src('app/checkout/CheckoutForm.tsx');
  assert.doesNotMatch(checkoutForm, /Announcements/);
});

test('ANN-ADMIN: dashboard exposes the announcements section', () => {
  const dashboard = src('app/admin/(dashboard)/page.tsx');
  assert.match(dashboard, /\/admin\/announcements/);
});
