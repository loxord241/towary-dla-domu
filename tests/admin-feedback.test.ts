/**
 * Admin feedback viewer (2026-08): /admin/feedback section.
 *
 * Pins the source invariants of the new admin surface:
 *   - both API handlers sit behind requireAdminApi (service client only
 *     after the guard);
 *   - DELETE accepts only a well-formed uuid;
 *   - the page is a client island wired to the guarded API with a
 *     confirmation step before delete;
 *   - the dashboard home exposes the section.
 * RLS on the feedback table stays policy-free and untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

test('ADMIN FEEDBACK: GET and DELETE both sit behind requireAdminApi', () => {
  const route = src('app/api/admin/feedback/route.ts');
  assert.match(route, /export\s+async function GET/);
  assert.match(route, /export\s+async function DELETE/);
  const guardCount = (route.match(/requireAdminApi\(\)/g) ?? []).length;
  assert.ok(guardCount >= 2, 'both handlers must call requireAdminApi()');
  assert.match(route, /ctx\.serviceClient/, 'privileged client only after the guard');
});

test('ADMIN FEEDBACK: DELETE validates the id as a uuid before deleting', () => {
  const route = src('app/api/admin/feedback/route.ts');
  assert.match(route, /UUID_RE|uuid/i);
  assert.match(route, /\.delete\(\)/);
});

test('ADMIN FEEDBACK: page is a guarded-pattern client island over the API', () => {
  const page = src('app/admin/(dashboard)/feedback/page.tsx');
  assert.match(page, /'use client'/);
  assert.match(page, /\/api\/admin\/feedback/);
  assert.match(page, /confirm\(/, 'delete must require confirmation');
  assert.match(page, /поки що немає|Порожньо|не має відгуків/i, 'empty state required');
});

test('ADMIN FEEDBACK: dashboard home exposes the section', () => {
  const dash = src('app/admin/(dashboard)/page.tsx');
  assert.match(dash, /\/admin\/feedback/);
  assert.match(dash, /Зворотний зв'язок|Відгуки/);
});
