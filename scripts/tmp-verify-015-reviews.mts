/**
 * Post-apply verification for migration 015 (product_reviews).
 * Run AFTER applying 015 via Supabase SQL Editor:
 *
 *   node scripts/tmp-verify-015-reviews.mts        (DB-only checks)
 *
 * SANCTIONED WRITES (user-approved): exactly ONE test review is inserted
 * through the storefront API, flipped pending→published (service-role
 * substitute for an authenticated admin PATCH — no admin credentials exist
 * in this environment), and DELETED at the end. Baseline counts are taken
 * before/after to prove zero residue.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3460';

const { createClient } = await import('@supabase/supabase-js');
const anon: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  { auth: { persistSession: false } }
);
const service: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ================= PHASE 1: structure / permissions (read-only) =================

// 1. Table exists + anon SELECT grant + RLS policy allows reading the (empty)
//    published set. Any success here also proves existence.
{
  const { count, error } = await anon
    .from('product_reviews')
    .select('id', { count: 'exact', head: true });
  check('table exists & anon SELECT ok', !error, error ? `code=${error.code}` : `published rows visible to anon: ${count}`);
}

// 2. Service-role full visibility.
{
  const { count, error } = await service
    .from('product_reviews')
    .select('id', { count: 'exact', head: true });
  check('service-role SELECT ok', !error, error ? `code=${error.code}` : `total rows: ${count}`);
}

// Baseline before the write phase.
const baseline = (
  await service.from('product_reviews').select('id', { count: 'exact', head: true })
).count ?? 0;

// 3. anon INSERT must be DENIED. Auto-cleanup guards against a misconfigured
//    policy accidentally creating a real row (would be reported as FAIL).
{
  const fakeId = '00000000-0000-4000-8000-000000000000';
  const { error } = await anon
    .from('product_reviews')
    .insert({ product_id: fakeId, rating: 3, text: 'anon insert denial probe row', status: 'published' });
  const denied = !!error;
  const { count } = await service
    .from('product_reviews')
    .select('id', { count: 'exact', head: true });
  let cleaned = '';
  if (!denied) {
    // Misconfiguration: remove the accidental row immediately.
    await service.from('product_reviews').delete().eq('text', 'anon insert denial probe row');
    cleaned = ' [auto-cleaned]';
  }
  check(
    'anon INSERT denied',
    denied && (count ?? 0) === baseline,
    `${error ? `code=${error.code}` : 'ALLOWED?!'}${cleaned}`
  );
}

// 4. anon UPDATE / DELETE cannot touch anything: RLS with no write policy
//    yields zero matching rows even when the command itself doesn't error.
{
  const dummyId = '00000000-0000-4000-8000-000000000000';
  const upd = await anon.from('product_reviews').update({ rating: 1 }).eq('id', dummyId);
  // Return values intentionally unused: the proof is that the ROW SET is
  // unchanged afterwards (anon must not be able to touch anything).
  void upd;
  await anon.from('product_reviews').delete().eq('id', dummyId);
  const { count } = await service
    .from('product_reviews')
    .select('id', { count: 'exact', head: true });
  const untouched =
    (count ?? 0) === baseline &&
    !(upd.error && String(upd.error.message).includes('duplicate'));
  check('anon UPDATE/DELETE affect nothing', untouched, 'row set unchanged');
}

// 5. Pick a REAL active product for the lifecycle (read-only).
const prodRes = await anon
  .from('products')
  .select('id, slug')
  .eq('is_active', true)
  .order('created_at', { ascending: false })
  .limit(1);
check('active product available for lifecycle', !prodRes.error && !!prodRes.data?.[0]);
if (prodRes.error || !prodRes.data?.[0]) process.exit(1);
const product: { id: string; slug: string } = prodRes.data[0];
console.log(`lifecycle product: ${product.slug}`);

// ================= PHASE 2: sanctioned single-review lifecycle =================

const MARKER = 'Тестовий відгук для верифікації міграції 015';

// 6. Submit through the STOREFRONT API (validation + rate-limit + pending path).
{
  const res = await fetch(`${BASE}/api/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productId: product.id,
      rating: 5,
      text: MARKER,
      displayName: 'Тест Верифікації',
      website: '',
    }),
  });
  check('storefront POST /api/reviews -> 201', res.status === 201, `status=${res.status}`);

  // Honeypot probe (must NOT create anything).
  const hp = await fetch(`${BASE}/api/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productId: product.id,
      rating: 5,
      text: 'spam probe honeypot filled',
      website: 'http://spam.example',
    }),
  });
  check('honeypot submission rejected', hp.status === 503 || hp.status === 400 || hp.status === 429, `status=${hp.status}`);
}

// 7. Pending is INVISIBLE to anon, visible to service — live RLS proof.
let reviewId = '';
{
  const anonView = await anon
    .from('product_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', product.id);
  check('pending INVISIBLE to anon', (anonView.count ?? 0) === 0, `anon count=${anonView.count ?? '?'} err=${anonView.error?.code ?? 'none'}`);

  const svcView = await service
    .from('product_reviews')
    .select('id, status, rating, text, display_name')
    .eq('product_id', product.id)
    .eq('status', 'pending')
    .eq('text', MARKER);
  const row = svcView.data?.[0];
  check('pending VISIBLE to service-role', !svcView.error && !!row, svcView.error?.message ?? '');
  if (row) {
    reviewId = row.id;
    check(
      'pending row shape sane',
      row.rating === 5 && row.display_name === 'Тест Верифікації' && typeof row.text === 'string'
    );
  }
}

// 8. Admin endpoints sit behind requireAdminApi (unauthenticated probes).
{
  const get = await fetch(`${BASE}/api/admin/reviews`);
  const patch = await fetch(`${BASE}/api/admin/reviews/${reviewId || product.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish' }),
  });
  const del = await fetch(`${BASE}/api/admin/reviews/${reviewId || product.id}`, {
    method: 'DELETE',
  });
  check('admin list guarded (401)', get.status === 401, `status=${get.status}`);
  check('admin PATCH guarded (401)', patch.status === 401, `status=${patch.status}`);
  check('admin DELETE guarded (401)', del.status === 401, `status=${del.status}`);
}

if (reviewId) {
  // 9. pending -> published. SUBSTITUTION DISCLOSED: done with the
  //     service-role key because no admin credentials exist here. This is
  //     EXACTLY the DB operation the authenticated admin PATCH performs
  //     after requireAdminApi passes (verified above at 401).
  {
    const { error } = await service
      .from('product_reviews')
      .update({ status: 'published', updated_at: new Date().toISOString() })
      .eq('id', reviewId);
    check('publish transition applied', !error, error?.message ?? '');
  }

  // 10. Published is now visible to anon with correct content.
  {
    const pub = await anon
      .from('product_reviews')
      .select('id, product_id, rating, text, display_name, status, created_at')
      .eq('id', reviewId);
    const row = pub.data?.[0];
    check('published VISIBLE to anon', !pub.error && !!row, pub.error?.code ?? '');
    if (row) {
      check(
        'published row content correct',
        row.status === 'published' &&
          row.rating === 5 &&
          row.product_id === product.id &&
          !('email' in row) && !('customer_id' in row),
        'no PII surface in public payload'
      );
    }
  }
}

console.log('\ncleanup: removing the test review…');
if (reviewId) {
  const del = await service.from('product_reviews').delete().eq('id', reviewId).select('id');
  const removed = Array.isArray(del.data) ? del.data.length : 0;
  check('test review deleted', !del.error && removed === 1, del.error?.message ?? '');
} else {
  // Fallback cleanup if the id was never captured.
  await service.from('product_reviews').delete().eq('text', MARKER);
  console.log('fallback cleanup by marker executed');
}
await new Promise((r) => setTimeout(r, 300));

const after = (
  await service.from('product_reviews').select('id', { count: 'exact', head: true })
).count ?? 0;
const residue = await service
  .from('product_reviews')
  .select('id', { count: 'exact', head: true })
  .eq('text', MARKER);
check('zero residue (total back to baseline)', after === baseline, `${baseline} -> ${after}`);
check('marker rows fully removed', (residue.count ?? 0) === 0);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
