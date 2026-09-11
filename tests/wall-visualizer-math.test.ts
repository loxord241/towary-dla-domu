import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipPathForQuad,
  homography,
  stripsForWall,
  toNorm,
  toPx,
  wallWidthM,
  type Quad,
} from '../app/lib/wallpapers/visualizer-math.ts';

const rect: Quad = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 50 },
  { x: 0, y: 50 },
];

test('homography: тождественный quad возвращает identity-matrix3d и точные углы', () => {
  const h = homography(rect, { w: 100, h: 50 });
  assert.ok(h);
  assert.equal(
    h.css,
    'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)',
  );
  for (const [i, p] of rect.entries()) {
    const out = h.apply(p.x, p.y);
    assert.ok(Math.abs(out.x - p.x) < 1e-6 && Math.abs(out.y - p.y) < 1e-6);
  }
});

test('homography: перенос quad — apply() маппит углы элемента в углы quad', () => {
  const shifted: Quad = rect.map((p) => ({ x: p.x + 40, y: p.y + 15 })) as Quad;
  const h = homography(shifted, { w: 100, h: 50 });
  assert.ok(h);
  const corners = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
    { x: 0, y: 50 },
  ];
  for (const [i, p] of corners.entries()) {
    const out = h.apply(p.x, p.y);
    assert.ok(Math.abs(out.x - shifted[i]!.x) < 1e-6);
    assert.ok(Math.abs(out.y - shifted[i]!.y) < 1e-6);
  }
});

test('homography: перспективный (неаффинный) quad — средняя точка проецируется внутрь', () => {
  const persp: Quad = [
    { x: 0, y: 0 },
    { x: 200, y: 20 },
    { x: 180, y: 180 },
    { x: 20, y: 160 },
  ];
  const h = homography(persp, { w: 100, h: 100 });
  assert.ok(h);
  const c = h.apply(50, 50);
  assert.ok(c.x > 0 && c.x < 200 && c.y > 0 && c.y < 180);
});

test('homography: вырожденный quad (линия) → null', () => {
  const line: Quad = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ];
  assert.equal(homography(line, { w: 100, h: 50 }), null);
});

test('clipPathForQuad: polygon в пикселях по порядку TL,TR,BR,BL', () => {
  assert.equal(
    clipPathForQuad(rect),
    'polygon(0px 0px, 100px 0px, 100px 50px, 0px 50px)',
  );
});

test('toPx/toNorm: roundtrip нормализованных координат', () => {
  const n: Quad = [
    { x: 0.1, y: 0.2 },
    { x: 0.9, y: 0.1 },
    { x: 0.95, y: 0.9 },
    { x: 0.05, y: 0.85 },
  ];
  const px = toPx(n, { w: 200, h: 100 });
  assert.equal(px[0]!.x, 20);
  assert.equal(px[2]!.y, 90);
  const back = toNorm(px, { w: 200, h: 100 });
  assert.ok(Math.abs(back[1]!.x - 0.9) < 1e-9);
});

test('wallWidthM: квадратная стена 100x100px при высоте 2.7м = 2.7м', () => {
  const sq: Quad = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  assert.ok(Math.abs(wallWidthM(sq, 2.7) - 2.7) < 1e-9);
});

test('stripsForWall: округление вверх и защита от мусора', () => {
  assert.equal(stripsForWall(3.19, 53), 7);
  assert.equal(stripsForWall(3.18, 53), 6);
  assert.equal(stripsForWall(0, 53), 0);
  assert.equal(stripsForWall(-2, 53), 0);
  assert.equal(stripsForWall(4, 0), 0);
  assert.equal(stripsForWall(Number.NaN, 53), 0);
});
