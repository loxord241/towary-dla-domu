/**
 * F13: admin PUT «make image main» flow.
 *
 * planMainPromotion (pure) decides the ordered steps; the route applies
 * them sequentially with product_id+id guards. Static invariants pin the
 * route-side guarantees that a unit test cannot: demote-before-promote,
 * per-update product_id guards, targeted 23505→409 mapping, absence of
 * DELETE/INSERT, and the whitelisted field patch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { planMainPromotion } = await import('../app/lib/admin-image-main.ts');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const routeSrc = readFileSync(
  path.join(root, 'app/api/admin/products/[id]/images/[imageId]/route.ts'),
  'utf8'
);

test('F13 #1 old main + promote another → [demote(old), promote] in this order', () => {
  const steps = planMainPromotion({ targetIsAlreadyMain: false, otherMainId: 'old-main' });
  assert.deepEqual(steps, [
    { op: 'demote-current-main', id: 'old-main' },
    { op: 'patch-target', includeIsMain: true },
  ]);
});

test('F13 #2 selected image already main → no demote, no redundant is_main write', () => {
  const steps = planMainPromotion({ targetIsAlreadyMain: true, otherMainId: null });
  assert.deepEqual(steps, [{ op: 'patch-target', includeIsMain: false }]);
  // includeIsMain=false means the flag itself is never rewritten
  assert.ok(!steps.some((s) => s.op === 'demote-current-main'));
});

test('F13 #3 no current main → single promote step', () => {
  const steps = planMainPromotion({ targetIsAlreadyMain: false, otherMainId: null });
  assert.deepEqual(steps, [{ op: 'patch-target', includeIsMain: true }]);
});

test('F13 #4 unique-conflict mapping: 23505 → 409 «головне зображення», never SKU/slug text', () => {
  assert.match(routeSrc, /code === '23505'/);
  const conflictStart = routeSrc.indexOf("code === '23505'");
  const conflictBlock = routeSrc.slice(conflictStart, conflictStart + 400);
  assert.match(conflictBlock, /status: 409/);
  assert.match(conflictBlock, /головне зображення/);
  assert.ok(!conflictBlock.includes('SKU'), 'конфликт main не должен отдавать текст про SKU/slug');
});

test('F13 #5 isolation: demote and promote are both guarded by exact id + product_id', () => {
  // demote targets the resolved previous-main row
  const demoteIdx = routeSrc.indexOf("op === 'demote-current-main'");
  const demoteBlock = routeSrc.slice(demoteIdx, routeSrc.indexOf('continue;', demoteIdx));
  assert.ok(demoteBlock.includes(".eq('id', step.id)"), 'demote должен быть ограничен id строки');
  assert.ok(demoteBlock.includes(".eq('product_id', id)"), 'demote должен быть ограничен product_id');
  // promote targets only the requested row of THIS product
  const promoteIdx = routeSrc.indexOf("fields.is_main = true");
  const promoteBlock = routeSrc.slice(promoteIdx, routeSrc.indexOf("return NextResponse.json({ image: data });", promoteIdx));
  assert.ok(promoteBlock.includes(".eq('id', imageId)"));
  assert.ok(promoteBlock.includes(".eq('product_id', id)"));
  // make-main must not use DELETE/INSERT (scope: the PUT handler body;
  // the sibling DELETE endpoint legitimately uses .delete())
  const putStart = routeSrc.indexOf('export async function PUT');
  const putEnd = routeSrc.indexOf('export async function DELETE');
  const putBody = routeSrc.slice(putStart, putEnd === -1 ? routeSrc.length : putEnd);
  assert.ok(!/\.(delete|insert)\(/.test(putBody), 'запрещены DELETE/INSERT для make-main');
});

test('F13 #6 promotion patch carries only requested fields (no image_url/alt/sort side-effects)', () => {
  const steps = planMainPromotion({ targetIsAlreadyMain: false, otherMainId: 'x' });
  for (const s of steps) {
    const keys = Object.keys(s).filter((k) => k !== 'op');
    for (const key of keys) {
      assert.ok(
        ['id', 'includeIsMain'].includes(key),
        `step содержит неожиданное поле ${key} — план не должен переносить контентные поля`
      );
    }
  }
  // route builds promote fields from baseFields (whitelist) + is_main only
  const promoteIdx = routeSrc.indexOf("const fields: Record<string, unknown> = { ...baseFields };");
  const promoteBlock = routeSrc.slice(promoteIdx, promoteIdx + 300);
  assert.ok(promoteBlock.includes("fields.is_main = true"));
  assert.ok(!promoteBlock.includes('image_url'));
});

test('F13 regression: plain is_main=false path keeps single guarded update', () => {
  const plainIdx = routeSrc.indexOf('// ---- plain patch');
  const plainBlock = routeSrc.slice(plainIdx, routeSrc.indexOf('// ---- make-main flow'));
  assert.match(plainBlock, /\.eq\('id', imageId\)/);
  assert.match(plainBlock, /\.eq\('product_id', id\)/);
});
