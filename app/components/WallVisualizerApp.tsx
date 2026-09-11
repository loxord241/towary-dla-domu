'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { homography, toPx, type Quad, type QuadN } from '@/app/lib/wallpapers/visualizer-math';
import rooms from '../../public/rooms/rooms.json';
import type { WallpaperSwatch } from '@/app/lib/catalog';

/**
 * Страница-примерочная (бриф владельца 2026-09-11, референс AERIAL):
 * комната на всё окно, справа/снизу — панель образцов; тап по образцу —
 * шпалеры «сами клеятся» на стену (гомография из visualizer-math).
 * Никаких ручек, слайдера и калькулятора внутри — чистый просмотр.
 */

interface RoomPreset {
  id: string;
  src: string;
  label: string;
  /** Нормализованные 0..1 углы стены из rooms.json: [[x,y] × 4], TL,TR,BR,BL. */
  wall: [number, number][];
}

const ROOMS = rooms as unknown as RoomPreset[];
/** Физический масштаб тайлинга: высота стены по умолчанию. */
const WALL_HEIGHT_M = 2.7;

export default function WallVisualizerApp({
  swatches,
  initialSlug,
  initialRoom,
}: {
  swatches: WallpaperSwatch[];
  initialSlug: string | null;
  initialRoom: string | null;
}) {
  const initial =
    swatches.find((s) => s.slug === initialSlug) ?? swatches[0] ?? null;
  const [selectedSlug, setSelectedSlug] = useState<string | null>(
    initial?.slug ?? null,
  );
  const [roomId, setRoomId] = useState<string>(
    ROOMS.some((r) => r.id === initialRoom) ? initialRoom! : ROOMS[0]!.id,
  );
  const [query, setQuery] = useState('');

  // Мёртвые хотлинки (сайт поставщика иногда отдаёт 404 на старые сканы):
  // образец с битой картинкой выбраковывается молча.
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const markBroken = (slug: string): void => {
    setBroken((prev) => {
      if (prev.has(slug)) return prev;
      const next = new Set(prev);
      next.add(slug);
      return next;
    });
  };
  const alive = useMemo(
    () => swatches.filter((s) => !broken.has(s.slug)),
    [swatches, broken],
  );

  const room = ROOMS.find((r) => r.id === roomId) ?? ROOMS[0]!;
  // rooms.json хранит точки МАССИВАМИ [x,y] — переводим в объекты Point. 
  const quadN: QuadN = room.wall.map(([x, y]) => ({ x, y })) as QuadN;
  // Выбранный образец — только среди живых; битый выбор → первый живой.
  const aliveSelected = alive.find((s) => s.slug === selectedSlug) ?? null;
  const selected = aliveSelected ?? (selectedSlug === null ? initial : (alive[0] ?? null));
  const active = selected;

  const stageRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (el === null) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [room]);

  // Битая текстура выбранного образца: выбраковываем и переключаемся
  // на первый живой (стена никогда не остаётся пустой).
  useEffect(() => {
    if (selected === null) return;
    const probe = new Image();
    probe.onerror = () => {
      markBroken(selected.slug);
      setSelectedSlug((cur) => alive.find((s) => s.slug !== cur)?.slug ?? cur);
    };
    probe.src = selected.imageUrl;
  }, [selected, alive]);

  // Deep-link: /vizualizator?wallpaper=<slug> — синхронизируем адрес,
  // чтобы «поделиться этим видом» работало без перезагрузки.
  useEffect(() => {
    if (selected === null) return;
    const url = `/vizualizator?wallpaper=${selected.slug}&room=${room.id}`;
    window.history.replaceState(null, '', url);
  }, [selected, room.id]);

  const quadPx = useMemo<Quad | null>(
    () => (box.w <= 0 || box.h <= 0 ? null : toPx(quadN, box)),
    [quadN, box],
  );
  const bbox = useMemo<{ w: number; h: number } | null>(() => {
    if (quadPx === null) return null;
    const xs = quadPx.map((p: { x: number; y: number }) => p.x);
    const ys = quadPx.map((p: { x: number; y: number }) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return w > 0 && h > 0 ? { w, h } : null;
  }, [quadPx]);
  const homog = useMemo(
    () => (quadPx === null || bbox === null ? null : homography(quadPx, bbox)),
    [quadPx, bbox],
  );

  const rollWidthCm = selected?.rollWidthCm ?? 53;
  const pxPerMeter = quadPx === null ? 0 : verticalAvgHeightPx(quadPx) / WALL_HEIGHT_M;
  const stripPx = (rollWidthCm / 100) * pxPerMeter;

  const q = query.trim().toLowerCase();
  const visible = alive.filter((s) => s.name.toLowerCase().includes(q));

  return (
    <div className="flex min-h-[100dvh] flex-col bg-gray-100 lg:flex-row">
      {/* Сцена */}
      <div className="relative lg:flex-1">
        <div ref={stageRef} className="relative select-none">
          {/* eslint-disable-next-line @next/next/no-img-element -- бокс <img> измеряется ResizeObserver-ом; статика /public */}
          <img
            src={room.src}
            alt={room.label}
            draggable={false}
            className="block max-h-[52vh] w-full object-cover lg:max-h-[100dvh]"
          />
          {quadPx !== null && homog !== null && bbox !== null && active !== null && (
            <div
              className="absolute left-0 top-0"
              style={{
                width: bbox.w,
                height: bbox.h,
                backgroundImage: `url("${active.imageUrl}")`,
                backgroundRepeat: 'repeat',
                backgroundSize: `${stripPx}px auto`,
                transform: homog.css,
                transformOrigin: '0 0',
              }}
            />
          )}
        </div>

        {/* Переключатель комнат */}
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-2">
          {ROOMS.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRoomId(r.id)}
              aria-pressed={r.id === room.id}
              className={`min-h-[44px] rounded-full px-4 text-base font-medium shadow-md transition-colors motion-reduce:transition-none ${
                r.id === room.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-white/90 text-gray-800 hover:bg-white'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {active !== null && (
          <div className="absolute bottom-3 right-3 max-w-[45%] rounded-full bg-black/60 px-4 py-2 text-right">
            <p className="wrap-anywhere text-sm font-semibold text-white">
              {active.name}
            </p>
            <Link
              href={`/product/${active.slug}`}
              className="text-xs text-blue-200 underline hover:text-white"
            >
              До товару →
            </Link>
          </div>
        )}
      </div>

      {/* Панель образцов */}
      <aside className="flex w-full flex-col border-t border-gray-200 bg-white lg:h-[100dvh] lg:w-[380px] lg:border-l lg:border-t-0">
        <div className="border-b border-gray-100 px-4 pb-3 pt-4">
          <h1 className="text-lg font-bold text-gray-900">
            Візуалізатор шпалер
          </h1>
          <label className="mt-3 block">
            <span className="sr-only">Пошук шпалер</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Пошук за назвою…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </label>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-4 lg:overflow-y-auto">
          {visible.map((swatch) => {
            const active = swatch.slug === selectedSlug;
            return (
              <div
                key={swatch.slug}
                className={`rounded-xl border p-2 transition-colors motion-reduce:transition-none ${
                  active ? 'border-blue-600 ring-2 ring-blue-600' : 'border-gray-200'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedSlug(swatch.slug)}
                  aria-label={`Приклеїти ${swatch.name}`}
                  aria-pressed={active}
                  className="block w-full overflow-hidden rounded-lg"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- миниатюра-образец, ленивая загрузка */}
                  <img
                    src={swatch.imageUrl}
                    alt=""
                    loading="lazy"
                    onError={() => markBroken(swatch.slug)}
                    className="h-24 w-full object-cover"
                  />
                </button>
                <p className="wrap-anywhere mt-1.5 text-xs text-gray-800">
                  {swatch.name}
                </p>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-sm font-semibold text-blue-700">
                    {swatch.price} {swatch.currency === 'UAH' ? 'грн' : swatch.currency}
                  </span>
                  <Link
                    href={`/product/${swatch.slug}`}
                    aria-label={`До товару ${swatch.name}`}
                    className="rounded p-2 text-xs text-gray-400 hover:text-blue-600"
                  >
                    ↗
                  </Link>
                </div>
              </div>
            );
          })}
          {visible.length === 0 && (
            <p className="col-span-2 py-8 text-center text-base text-gray-500">
              Нічого не знайдено
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

/** Средняя высота стены в px: вертикальные стороны quad (BL-TL, TR-BR). */
function verticalAvgHeightPx(quad: NonNullable<ReturnType<typeof toPx>>): number {
  const [tl, tr, br, bl] = quad;
  const left = Math.hypot(tl!.x - bl!.x, tl!.y - bl!.y);
  const right = Math.hypot(tr!.x - br!.x, tr!.y - br!.y);
  return (left + right) / 2;
}
