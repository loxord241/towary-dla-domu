/**
 * Task #5B (2026-08-31): PDP on-demand ISR + client-side reviews pagination.
 *
 * The PDP used to read searchParams (reviews_page) — the ONLY request-time
 * API on the route — which forced dynamic rendering. Now:
 *   - the route is on-demand ISR: revalidate = 60 + generateStaticParams []
 *     (dynamicParams defaults to true, so unknown slugs still render on
 *     demand and notFound() — audit Task #5A, docs generate-static-params);
 *   - the page always server-renders reviews page 1 (SSR props);
 *   - pages beyond the first come from the public GET /api/reviews endpoint
 *     which reuses the cached fetchPublishedReviews read (anon key, RLS,
 *     60s Data Cache keyed by (productId, page)) — never the service-role
 *     client, which stays reserved for POST inserts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pdp = () => readFileSync('app/product/[slug]/page.tsx', 'utf8');
const reviewsRoute = () => readFileSync('app/api/reviews/route.ts', 'utf8');
const reviewsSection = () =>
  readFileSync('app/components/ProductReviews.tsx', 'utf8');

test('PDP-ISR: route is on-demand ISR (revalidate 60, generateStaticParams [])', () => {
  const page = pdp();
  assert.match(page, /export const revalidate = 60/);
  assert.match(
    page,
    /export async function generateStaticParams\(\)[\s\S]{0,120}?return \[\]/
  );
  // dynamicParams must stay true (default): unknown slugs render on demand
  // and honestly 404 through notFound().
  assert.doesNotMatch(page, /dynamicParams\s*=\s*false/);
});

test('PDP-ISR: page no longer reads searchParams (reviews_page)', () => {
  const page = pdp();
  assert.doesNotMatch(page, /searchParams/);
  assert.doesNotMatch(page, /reviews_page/);
});

test('PDP-ISR: first reviews page stays server-rendered', () => {
  const page = pdp();
  assert.match(page, /fetchPublishedReviews\(\s*product\.id,\s*1\s*\)/);
  assert.match(page, /<ProductReviews/);
  assert.match(page, /summary=\{reviewSummary\}/);
  assert.match(page, /data=\{reviewsData\}/);
});

test('PDP-ISR: rest of the page logic is untouched', () => {
  const page = pdp();
  assert.match(page, /Promise\.allSettled/);
  assert.match(page, /fetchRelatedProducts\(product\)/);
  assert.match(page, /buildProductJsonLd/);
  assert.match(page, /buildProductBreadcrumbJsonLd/);
  assert.match(page, /buildProductMetaDescription/);
  assert.match(page, /alternates: \{ canonical \}/);
});

test('REVIEWS GET: public endpoint reuses the cached read, no service-role', () => {
  const route = reviewsRoute();
  assert.match(route, /export async function GET\(request: Request\)/);
  assert.match(route, /fetchPublishedReviews\(/);
  assert.doesNotMatch(
    route,
    /SUPABASE_SERVICE_ROLE[\s\S]{0,200}fetchPublishedReviews/,
    'GET must go through the anon-key read, not the service client'
  );
  // POST (submission flow) must remain intact.
  assert.match(route, /export async function POST\(request: Request\)/);
  assert.match(route, /enforceRateLimit\(request, 'reviews'\)/);
  assert.match(route, /status: 'pending'/);
});

test('REVIEWS GET: UUID validation + integer page guard', () => {
  const route = reviewsRoute();
  assert.match(route, /isUuid\(productId\)/);
  assert.match(route, /Number\.isInteger/);
});

test('PAGINATION: section keeps SSR props and ?reviews_page hrefs, goes client-side', () => {
  const section = reviewsSection();
  assert.match(section, /'use client'/);
  assert.match(section, /reviews_page=/, 'legacy/SEO hrefs preserved');
  assert.match(section, /\/api\/reviews\?/, 'client pagination fetches the GET endpoint');
  assert.match(section, /history\.replaceState/, 'URL stays shareable without a server navigation');
  assert.doesNotMatch(section, /dangerouslySetInnerHTML/);
});
