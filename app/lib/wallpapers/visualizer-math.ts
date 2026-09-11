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

/** Гаусс для 8x8 (partial pivoting); null при вырождении. */
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
