# Wall Visualizer «Подивитись в інтер'єрі» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На PDP каждой wc-* позиции с фото — модалка-визуализатор: фото комнаты-пресета со «наклеенной» шпалерой, 4 двигающиеся угловые ручки стены, слайдер высоты, подсчёт смуг.

**Architecture:** Чистая гомография (unit square → quad) рендерится как CSS `matrix3d` поверх фото комнаты; обои — `background-repeat` внутри `clip-path`-обёртки (канвас не используется — обходит CORS хотлинков Славы). Три узла: pure-math модуль, клиентский компонент, статические пресеты комнат.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind 4, node:test (проектный обычай — статические инварианты для .tsx), без новых зависимостей.

**Spec:** `docs/superpowers/specs/2026-09-11-wall-visualizer-design.md`

## Global Constraints

- Tailwind 4.3.3 (утилиты `wrap-anywhere`, `size-*`, arbitrary values доступны).
- Все input/select/textarea ≥16px (`text-base`); тап-таргеты ≥44px; `motion-reduce` на анимациях (мобильный контракт 2026-09-11).
- Тексты интерфейса — украинским; комментарии в коде — русским (обычай репо).
- Без новых npm-зависимостей. Канвас/WebGL не используются (CORS хотлинков oboi-slav-oboi.com).
- Тесты: node:test, запуск `node --test tests/<file>`; полный прогон `npm test`; после кода — `npx tsc --noEmit`.
- Коммиты: после каждой задачи, сообщения по обычаю репо (feat/test/fix...).
- Ролл-контракт: `rollSize === null` → тайлинг 0.53 м + предупреждение (ничего не вгадываем).

---

### Task 1: Pure-математика `visualizer-math.ts` (гомография, clip-path, метры/смуги)

**Files:**
- Create: `app/lib/wallpapers/visualizer-math.ts`
- Test: `tests/wall-visualizer-math.test.ts`

**Interfaces:**
- Consumes: ничего (pure, только Math).
- Produces (используют Tasks 3-4):
  - `type Point = { x: number; y: number }`
  - `type Quad = [Point, Point, Point, Point]` — порядок TL, TR, BR, BL
  - `type QuadN = Quad` — нормализованные 0..1 координаты
  - `type Size = { w: number; h: number }`
  - `homography(quad: Quad, size: Size): { css: string; apply: (x: number, y: number) => Point } | null`
  - `clipPathForQuad(quad: Quad): string`
  - `toPx(quad: QuadN, size: Size): Quad`, `toNorm(quad: Quad, size: Size): QuadN`
  - `wallWidthM(quad: Quad, wallHeightM: number): number`
  - `stripsForWall(wallWidthM: number, rollWidthCm: number): number`

- [ ] **Step 1: Write the failing test**

```ts
// tests/wall-visualizer-math.test.ts
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
  // центр элемента лежит строго внутри четырёхугольника (шнуровка лучей)
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
  assert.equal(stripsForWall(3.19, 53), 7); // 6 полос = 3.18м — не хватает
  assert.equal(stripsForWall(3.18, 53), 6);
  assert.equal(stripsForWall(0, 53), 0);
  assert.equal(stripsForWall(-2, 53), 0);
  assert.equal(stripsForWall(4, 0), 0);
  assert.equal(stripsForWall(Number.NaN, 53), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/wall-visualizer-math.test.ts`
Expected: FAIL — модуль не существует.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/wallpapers/visualizer-math.ts
/**
 * Pure-математика визуализатора шпалер (spec §3.1:
 * docs/superpowers/specs/2026-09-11-wall-visualizer-design.md).
 *
 * Гомография отображает прямоугольный элемент (0,0),(w,0),(w,h),(0,h)
 * в четырёхугольник стены на фото комнаты; рендерится как CSS matrix3d
 * (канвас не используется — текстура это хотлинк oboi-slav-oboi.com,
 * canvas её «испачкал» бы CORS-ом).
 * Quad в пикселях бокса фото; порядок точек TL, TR, BR, BL.
 * Без Next.js импортов — node:test и переиспользование на сервере.
 */

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
/** Четырёхугольник стены, порядок: TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];
/** Quad в нормализованных 0..1 координатах бокса фото. */
export type QuadN = Quad;

const EPS = 1e-9;

/** Гаусс для 8x8 (частный pivoting); null при вырождении. */
function solve8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    if (Math.abs(M[piv]![col]!) < EPS) return null;
    if (piv !== col) {
      const t = M[col]!;
      M[col] = M[piv]!;
      M[piv] = t;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) {
        M[r]![c] = M[r]![c]! - f * M[col]![c]!;
      }
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/**
 * Гомография локальных координат элемента (0,0),(w,0),(w,h),(0,h)
 * в quad. CSS matrix3d заполняется поколоночно: перспективное деление
 * даёт 4-е столбцы [m31, m32, 0, 1].
 */
export function homography(
  quad: Quad,
  size: Size,
): { css: string; apply: (x: number, y: number) => Point } | null {
  const src: Point[] = [
    { x: 0, y: 0 },
    { x: size.w, y: 0 },
    { x: size.w, y: size.h },
    { x: 0, y: size.h },
  ];
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i]!;
    const d = quad[i]!;
    A.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.y * s.x]);
    b.push(d.x);
    A.push([0, 0, 0, s.x, s.y, 1, -d.x * s.y, -d.y * s.y]);
    b.push(d.y);
  }
  const m = solve8(A, b);
  if (m === null) return null;
  const [m11, m12, m13, m21, m22, m23, m31, m32] = m;
  const denom = (x: number, y: number): number =>
    m31! * x + m32! * y + 1;
  for (const p of src) {
    if (Math.abs(denom(p.x, p.y)) < 1e-6) return null;
  }
  const apply = (x: number, y: number): Point => {
    const d = denom(x, y);
    return {
      x: (m11! * x + m12! * y + m13!) / d,
      y: (m21! * x + m22! * y + m23!) / d,
    };
  };
  const css =
    `matrix3d(${m11}, ${m21}, 0, ${m31}, ${m12}, ${m22}, 0, ${m32}, ` +
    `0, 0, 1, 0, ${m13}, ${m23}, 0, 1)`;
  return { css, apply };
}

export function clipPathForQuad(quad: Quad): string {
  return `polygon(${quad.map((p) => `${p.x}px ${p.y}px`).join(', ')})`;
}

export function toPx(quad: QuadN, size: Size): Quad {
  return quad.map((p) => ({ x: p.x * size.w, y: p.y * size.h })) as Quad;
}

export function toNorm(quad: Quad, size: Size): QuadN {
  if (size.w <= 0 || size.h <= 0) return quad;
  return quad.map((p) => ({ x: p.x / size.w, y: p.y / size.h })) as Quad;
}

/**
 * Ширина стены в метрах: высота известна от слайдера, ширина выводится
 * по пропорции спроецированной стены (средние длины сторон в пикселях).
 */
export function wallWidthM(quad: Quad, wallHeightM: number): number {
  const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
  const [p1, p2, p3, p4] = quad;
  const wPx = (dist(p1!, p2!) + dist(p4!, p3!)) / 2;
  const hPx = (dist(p1!, p4!) + dist(p2!, p3!)) / 2;
  if (!Number.isFinite(wPx) || !Number.isFinite(hPx) || hPx < EPS) return 0;
  if (!Number.isFinite(wallHeightM) || wallHeightM <= 0) return 0;
  return (wPx / hPx) * wallHeightM;
}

/** Смуг на стене: округление вверх; мусор на входе → 0. */
export function stripsForWall(wallWidthM: number, rollWidthCm: number): number {
  if (!Number.isFinite(wallWidthM) || wallWidthM <= 0) return 0;
  if (!Number.isFinite(rollWidthCm) || rollWidthCm <= 0) return 0;
  return Math.max(1, Math.ceil(wallWidthM / (rollWidthCm / 100)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/wall-visualizer-math.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/wallpapers/visualizer-math.ts tests/wall-visualizer-math.test.ts
git commit -m "feat(wallviz): pure homography/clip/meters math for the room visualizer"
```

---

### Task 2: Пресеты комнат (rooms.json, фото, CREDITS)

**Files:**
- Create: `public/rooms/rooms.json`
- Create: `public/rooms/{vitalnia,spalnia,dytiacha,kukhnia}.webp` (по ≤400KB, 1600px)
- Create: `public/rooms/CREDITS.md`

**Interfaces:**
- Produces: `rooms.json` со схемой, которую читает Task 3:
  `[{ "id": "vitalnia", "src": "/rooms/vitalnia.webp", "label": "Вітальня", "wall": [[0.30,0.22],[0.72,0.24],[0.70,0.78],[0.28,0.80]] }]` — wall в нормализованных 0..1 координатах, порядок TL,TR,BR,BL, quad ОХВАТЫВАЕТ видимую стену на фото.

- [ ] **Step 1: Скачать 4 стоковых фото** (Unsplash/Pexels — лицензии допускают коммерцию без атрибуции; ссылки источников всё равно фиксируем в CREDITS.md). Критерии отбора: пустая комната, стена занимает крупную часть кадра, стена без мебели/декора, съёмка «с уровня глаз», горизонт ≥1600px. Оркестратор показывает выбранные фото владельцу до финального коммита (spec §3.3).

- [ ] **Step 2: Оптимизировать** (Python + Pillow wheel по паттерну `/tmp/pylibs`, как xlrd/openpyxl):

```bash
PYTHONPATH=/tmp/pylibs python3 - <<'EOF'
from PIL import Image
import sys
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
w = 1600
if im.width > w:
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
im.save(dst, 'WEBP', quality=78, method=6)
EOF
```
Проверка: размер файла ≤400KB (`ls -la public/rooms/`), иначе quality ↓ на 6.

- [ ] **Step 3: rooms.json** — quad каждой стены выставляется по фото (разметка вручную по превью: 4 точки TL,TR,BR,BL нормализованных). Формат:

```json
[
  { "id": "vitalnia", "src": "/rooms/vitalnia.webp", "label": "Вітальня",
    "wall": [[0.30, 0.22], [0.72, 0.24], [0.70, 0.78], [0.28, 0.80]] },
  { "id": "spalnia", "src": "/rooms/spalnia.webp", "label": "Спальня",
    "wall": [[0.28, 0.20], [0.74, 0.22], [0.72, 0.80], [0.26, 0.82]] },
  { "id": "dytiacha", "src": "/rooms/dytiacha.webp", "label": "Дитяча",
    "wall": [[0.32, 0.24], [0.70, 0.22], [0.72, 0.76], [0.30, 0.80]] },
  { "id": "kukhnia", "src": "/rooms/kukhnia.webp", "label": "Кухня",
    "wall": [[0.26, 0.24], [0.74, 0.22], [0.72, 0.78], [0.24, 0.80]] }
]
```
(конкретные числа — по факту скачанных фото; схема и порядок точек — ровно такие)

- [ ] **Step 4: CREDITS.md** — для каждого фото: комната, URL источника, автор/лицензия (Unsplash License / Pexels License), дата скачивания.

- [ ] **Step 5: Sanity-проверка** — `python3 -c "import json;[print(r['id'],r['wall']) for r in json.load(open('public/rooms/rooms.json'))]"` → 4 записи, каждая wall — 4 точки в 0..1. Коммит после одобрения фото владельцем:

```bash
git add public/rooms
git commit -m "feat(wallviz): 4 room presets (stock photos, CREDITS) + rooms.json"
```

---

### Task 3: Компонент `WallVisualizer.tsx` + ленивый слот на PDP

**Files:**
- Create: `app/components/WallVisualizer.tsx`
- Create: `app/components/WallVisualizerSlot.tsx`
- Modify: `app/product/[slug]/page.tsx` (блок под галереей + `id="roll-calculator"` на обёртке калькулятора)
- Test: `tests/wall-visualizer.test.ts`

**Interfaces:**
- Consumes: Task 1 (`homography`, `clipPathForQuad`, `toPx`, `toNorm`, `wallWidthM`, `stripsForWall`, типы), Task 2 (`rooms.json` схема), `parseRollSize` уже в проекте (`app/lib/wallpapers/parse.ts`), `getMainPublicImageUrl` (`app/lib/supabase-storage.ts`).
- Produces: PDP рендерит `<WallVisualizerSlot textureUrl=… rollSize=… slug=… />` для wc-* с фото; `RollCalculator` обёрнут `<div id="roll-calculator">`.

**Компонентная механика (зафиксирована, чтобы Task 3 не изобретал):**
- `WallVisualizerSlot.tsx` — `'use client'`; рендерит только кнопку открытия; по клику `await import('./WallVisualizer')` (React `useState` + ручной lazy — НЕ next/dynamic, чтобы не зависеть от его поведения в Server Components) и показывает модалку.
- Измерение бокса фото: `useLayoutEffect` + `ResizeObserver` на wrapper (`<div className="relative">` с `<img className="w-full">`) → `{w,h}` rendered px; нормализованный quad из rooms.json переводится в px (`toPx`), все ручки/матрица работают в px.
- Слои внутри wrapper (z-порядок): `<img>` → clip-обёртка (`absolute inset-0`, `clipPathForQuad(pxQuad)`, внутрь — обои-div `absolute left-0 top-0` размером bbox quad c `backgroundImage`, `backgroundRepeat: 'repeat'`, `backgroundSize: ${stripPx}px auto`, `transform: homography(...).css`, `transformOrigin: '0 0'`) → 4 ручки-`<button>` (44px, `touch-action:none`, setPointerCapture, клавиши-стрелки шаг 0.01 нормализованных) → подпись комнаты.
- `stripPx = (rollWidthCm/100) * pxPerMeter`, где `pxPerMeter = avgHeightPx(quad) / wallHeightM`.
- Слайдер высоты: `<input type="range" min="2" max="3.5" step="0.05" className="text-base">` + подпись «Висота стіни: X,X м».
- Футер: «≈ N смуг для цієї стіни» (stripsForWall(wallWidthM(quadPx, h), rollWidthCm)); кнопки «Скинути» и «До калькулятора» (onClose + `document.getElementById('roll-calculator')?.scrollIntoView({behavior:'smooth'})`; scroll — только если элемент найден).
- localStorage: ключ `wallviz:${slug}:${roomId}`, запись quad-N при pointerup/keyup, чтение при открытии комнаты, try/catch (private mode → молча).
- Модалка: `role="dialog" aria-modal`, Esc, крестик 44px, `overscroll-contain`, `motion-reduce:transition-none`, фокус на крестике при открытии, возврат фокуса на кнопку открытия при закрытии, body scroll-lock паттерном проекта (`document.body.style.overflow = 'hidden'` + cleanup — его пиннят тесты).

- [ ] **Step 1: Write the failing static test**

```ts
// tests/wall-visualizer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');
const comp = read('app/components/WallVisualizer.tsx');
const slot = read('app/components/WallVisualizerSlot.tsx');
const pdp = read('app/product/[slug]/page.tsx');

test('wallviz: слот — client, ленивый import(), кнопка-открывашка', () => {
  assert.ok(slot.startsWith("'use client'"));
  assert.match(slot, /import\('\.\/WallVisualizer'\)/, 'ручной lazy import');
  assert.match(slot, /Подивитись в інтер'єрі/);
});

test('wallviz: модалка — a11y и мобильный контракт', () => {
  assert.match(comp, /role="dialog"/);
  assert.match(comp, /aria-modal/);
  assert.match(comp, /Escape/, 'закрытие по Esc');
  assert.match(comp, /document\.body\.style\.overflow = 'hidden'/, 'скролл-лок паттерна проекта');
  assert.match(comp, /overscroll-contain/);
  assert.match(comp, /motion-reduce:transition-none/);
  assert.match(comp, /touch-action:\s*none|touch-none/, 'ручки не скроллят страницу');
  const hit = comp.match(/h-11 w-11/g) ?? [];
  assert.ok(hit.length >= 5, 'ручки и крестик ≥44px');
});

test('wallviz: ручки — pointer capture + клавиатура, ничего не вгадывается', () => {
  assert.match(comp, /setPointerCapture/);
  assert.match(comp, /ArrowLeft/);
  assert.match(comp, /wallviz:\$\{/, 'localStorage-ключ per slug+room');
  assert.match(comp, /розмір рулона не вказано|орієнтовний/, 'подсказка при rollSize=null');
  assert.match(comp, /type="range"/);
  assert.match(comp, /min="2"/);
  assert.match(comp, /max="3\.5"/);
});

test('wallviz: математика из pure-модуля, тайлинг без канваса', () => {
  assert.match(comp, /from '@\/app\/lib\/wallpapers\/visualizer-math'/);
  assert.match(comp, /backgroundRepeat/, 'обои = background-repeat');
  assert.ok(!/canvas|getContext/.test(comp), 'канвас запрещён (CORS)');
  assert.match(comp, /stripsForWall/);
  assert.match(comp, /Скинути/);
  assert.match(comp, /До калькулятора/);
});

test('wallviz: PDP — гейт wc-* с фото, id калькулятора на месте', () => {
  assert.match(pdp, /WallVisualizerSlot/);
  assert.match(pdp, /id="roll-calculator"/);
  assert.match(
    pdp,
    /isWallpaper &&[\s\S]*galleryUrls\.length > 0[\s\S]*WallVisualizerSlot/,
    'блок только для шпалер с фото',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/wall-visualizer.test.ts`
Expected: FAIL — файлы не существуют.

- [ ] **Step 3: Implement** `WallVisualizerSlot.tsx` + `WallVisualizer.tsx` по «Компонентной механике» выше; правки PDP:

```tsx
// app/product/[slug]/page.tsx — импорт:
import WallVisualizerSlot from '@/app/components/WallVisualizerSlot';

// внутри карточки галереи, ПОСЛЕ <ProductGallery … />:
{isWallpaper && galleryUrls.length > 0 && (
  <WallVisualizerSlot
    textureUrl={galleryUrls[0]!}
    rollSize={rollSize}
    slug={product.slug}
  />
)}

// обёртка калькулятора (существующий блок):
{isWallpaper && (
  <div id="roll-calculator">
    <RollCalculator productId={product.id} rollSize={rollSize} />
  </div>
)}
```
`galleryUrls[0]!` — допустимо: гейт `galleryUrls.length > 0` стоит рядом; тугая проверка в слоте (пустой URL → return null) обязательна.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/wall-visualizer.test.ts && npx tsc --noEmit`
Expected: PASS, tsc 0 ошибок.

- [ ] **Step 5: Commit**

```bash
git add app/components/WallVisualizer.tsx app/components/WallVisualizerSlot.tsx app/product/[slug]/page.tsx tests/wall-visualizer.test.ts
git commit -m "feat(pdp): wall visualizer modal (drag wall corners, height slider, strips)"
```

---

### Task 4: Полная верификация и сборка (оркестратор)

**Files:** без новых; прогон всего.

- [ ] **Step 1:** `npm test` → 2054+ новых, 0 fail; `npm run lint` → 0 errors; `npx tsc --noEmit` → чисто.
- [ ] **Step 2:** `graphify update .`
- [ ] **Step 3:** показать владельцу 4 комнатных фото (Task 2) до финального пуша пресетов.
- [ ] **Step 4:** `git push` → деплой, отчёт владельцу: что открыто, как проверить с телефона.

---

## Self-Review

- **Spec coverage:** §2 UX-флоу → Task 3; §3.1 math → Task 1; §3.2 компонент+dynamic → Task 3 (ручной lazy вместо next/dynamic — причина указана); §3.3 пресеты → Task 2; §4 a11y/мобильный → Task 3 (+ пины в тесте); §5 производительность → Task 3 (lazy import, только при открытии); §6 edge cases → Task 1 (null/degenerate) + Task 3 (clamp, localStorage try/catch, empty url); §7 тесты → Steps 1 каждого task; §8 вне скоупа — не реализовано намеренно.
- **Placeholder scan:** «конкретные числа — по факту скачанных фото» в Task 2 — это не TBD, а явная процедура разметки по реальным фото (числа до фото выдумать нельзя). Остальное — полный код.
- **Type consistency:** `Quad`/`QuadN`/`Size`/`homography().css|apply`/`toPx`/`toNorm`/`wallWidthM`/`stripsForWall` — имена совпадают между Task 1 (produces) и Task 3 (consumes); ключ localStorage `wallviz:${slug}:${roomId}` одинаков в §3.2 спецификации, компонентной механике и тесте.
