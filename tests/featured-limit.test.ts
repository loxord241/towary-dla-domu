/** Max-8 business rule for «Популярні товари» (UI/API rule, NOT a DB constraint). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  MAX_FEATURED_PRODUCTS,
  FEATURED_LIMIT_MESSAGE,
  decideFeaturedToggle,
} from '../app/lib/featured-limit.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

test('FEATURED: cap constant is exactly 8', () => {
  assert.equal(MAX_FEATURED_PRODUCTS, 8);
});

test('FEATURED: turning OFF is always allowed, even at full capacity', () => {
  assert.deepEqual(
    decideFeaturedToggle({ currentlyFeatured: true, requestedFeatured: false, featuredCount: 8 }),
    { allowed: true }
  );
  assert.deepEqual(
    decideFeaturedToggle({ currentlyFeatured: false, requestedFeatured: false, featuredCount: 8 }),
    { allowed: true }
  );
});

test('FEATURED: keeping an already-featured product ON is a no-op allow', () => {
  assert.deepEqual(
    decideFeaturedToggle({ currentlyFeatured: true, requestedFeatured: true, featuredCount: 8 }),
    { allowed: true }
  );
  assert.deepEqual(
    decideFeaturedToggle({ currentlyFeatured: true, requestedFeatured: true, featuredCount: 3 }),
    { allowed: true }
  );
});

test('FEATURED: enabling under the cap is allowed', () => {
  assert.deepEqual(
    decideFeaturedToggle({ currentlyFeatured: false, requestedFeatured: true, featuredCount: 7 }),
    { allowed: true }
  );
  assert.deepEqual(
    decideFeaturedToggle({ currentlyFeatured: false, requestedFeatured: true, featuredCount: 0 }),
    { allowed: true }
  );
});

test('FEATURED: enabling at 8 (or more) is rejected with limit_reached', () => {
  assert.deepEqual(
    decideFeaturedToggle({ currentlyFeatured: false, requestedFeatured: true, featuredCount: 8 }),
    { allowed: false, reason: 'limit_reached' }
  );
  assert.deepEqual(
    decideFeaturedToggle({ currentlyFeatured: false, requestedFeatured: true, featuredCount: 9 }),
    { allowed: false, reason: 'limit_reached' }
  );
});

test('FEATURED: message explains the limit in Ukrainian', () => {
  assert.match(FEATURED_LIMIT_MESSAGE, /8/);
  assert.match(FEATURED_LIMIT_MESSAGE, /Популярн/);
});

// ---- static pins: enforcement + auth + UI ----

test('FEATURED API: PUT checks before update and REVERTS its own overshoot', () => {
  const route = src('app/api/admin/products/[id]/route.ts');
  assert.match(route, /decideFeaturedToggle/);
  assert.match(route, /countFeaturedProducts/);
  assert.match(route, /status: 409/, 'rejected enable answers 409');
  assert.match(route, /revert/i, 'post-update recount reverts overshoot');
});

test('FEATURED API: POST checks before insert and demotes its own overshoot', () => {
  const route = src('app/api/admin/products/route.ts');
  assert.match(route, /decideFeaturedToggle/);
  assert.match(route, /featured-count/, 'counter endpoint exists');
});

test('FEATURED API: admin auth guard intact in both product routes', () => {
  const listRoute = src('app/api/admin/products/route.ts');
  const itemRoute = src('app/api/admin/products/[id]/route.ts');
  // list route: GET + POST; item route: GET + PUT + DELETE.
  assert.equal((listRoute.match(/export async function/g) ?? []).length, 2);
  assert.equal((itemRoute.match(/export async function/g) ?? []).length, 3);
  for (const route of [listRoute, itemRoute]) {
    const parts = route
      .split(/export async function (?:GET|POST|PUT|DELETE)/)
      .slice(1);
    for (const part of parts) {
      const guardPos = part.indexOf('requireAdminApi()');
      assert.ok(guardPos >= 0, 'handler must call the guard');
      const dbPos = part.indexOf(".from('");
      if (dbPos >= 0) assert.ok(guardPos < dbPos, 'guard BEFORE any DB query');
    }
  }
});

test('FEATURED UI: badge reflects server row state on every page/search result', () => {
  const ui = src('app/admin/(dashboard)/products/page.tsx');
  // The badge renders from the per-row server payload — correct on ANY page.
  assert.match(ui, /product\.is_featured &&/);
});

test('FEATURED UI: modal shows counter, hint, disables at limit — no silent unselect', () => {
  const ui = src('app/admin/(dashboard)/products/page.tsx');
  assert.match(ui, /Обрано:/);
  assert.match(ui, /Популярні товари/);
  assert.match(ui, /featured-count/);
  assert.match(ui, /disabled=/, 'checkbox blocked at limit');
  assert.match(ui, /Ліміт/, 'explicit message instead of silent auto-removal');
});
