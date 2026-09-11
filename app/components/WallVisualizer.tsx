'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { RollSize } from '@/app/lib/wallpapers/parse';
import {
  clipPathForQuad,
  homography,
  stripsForWall,
  toPx,
  wallWidthM,
  type Point,
  type Quad,
  type QuadN,
  type Size,
} from '@/app/lib/wallpapers/visualizer-math';

/**
 * Модалка-визуализатор «Подивитись в інтер'єрі» (spec §3.2, план Task 3).
 *
 * Фото комнаты-пресета; поверх — quad стены с «наклеенной» шпалерой.
 * Техника наложения (без растровых канвасов — текстура является хотлинком):
 * обёртка с clip-path по quad, внутри div с background-repeat и
 * transform: matrix3d. Quad хранится нормализованным (0..1) и переводится
 * в px измеренного бокса фото, поэтому пропорции не искажаются.
 * SSR нет: модалка открывается лениво из WallVisualizerSlot по клику.
 */

export interface WallVisualizerProps {
  textureUrl: string;
  rollSize: RollSize | null;
  slug: string;
  onClose: () => void;
}

interface RoomPreset {
  id: string;
  src: string;
  label: string;
  /** Нормализованный 0..1 quad стены, порядок TL, TR, BR, BL. */
  wall: [number, number][];
}

// Ручки не доводят quad до вырождения: рамка 0.02..0.98 (spec §6).
const CLAMP_MIN = 0.02;
const CLAMP_MAX = 0.98;
/** Шаг стрелок клавиатуры в нормализованных координатах. */
const KEY_STEP = 0.01;
const DEFAULT_HEIGHT_M = 2.7;
// rollSize === null → тайлинг 0.53 м + предупреждение (контракт калькулятора).
const FALLBACK_ROLL_CM = 53;

const clampN = (v: number): number => Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, v));

const formatM = (v: number): string =>
  v.toLocaleString('uk-UA', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

/** «смуга / смуги / смуг» — украинское склонение для футера. */
function stripsLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'смуга';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'смуги';
  return 'смуг';
}

/** Защита от битого JSON в localStorage: 4 конечные точки. */
function isValidQuadN(value: unknown): value is QuadN {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (p): p is Point =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as Point).x === 'number' &&
        typeof (p as Point).y === 'number' &&
        Number.isFinite((p as Point).x) &&
        Number.isFinite((p as Point).y),
    )
  );
}

function presetToQuadN(wall: [number, number][]): QuadN {
  return wall.slice(0, 4).map(([x, y]) => ({ x, y })) as QuadN;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Средняя высота quad в px — «метр стены» на экране. */
function avgHeightPx(quad: Quad): number {
  return (dist(quad[0]!, quad[3]!) + dist(quad[1]!, quad[2]!)) / 2;
}

export default function WallVisualizer({
  textureUrl,
  rollSize,
  slug,
  onClose,
}: WallVisualizerProps) {
  const [rooms, setRooms] = useState<RoomPreset[] | null>(null);
  const [roomsFailed, setRoomsFailed] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [quadN, setQuadN] = useState<QuadN | null>(null);
  const [wallHeightM, setWallHeightM] = useState(DEFAULT_HEIGHT_M);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });

  const stageRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const room = rooms?.find((r) => r.id === roomId) ?? null;
  const showStage = room !== null && quadN !== null;

  // Первая комната: начальный quad выводим из пресета/localStorage прямо
  // при рендере (задокументированный React derive-паттерн «adjust state
  // when a prop changes» — вместо setState-in-effect).
  if (room !== null && quadN === null) {
    setQuadN(quadForRoom(room.id));
  }

  // rooms.json — статика из /public; ошибка → модалка с одним сообщением.
  useEffect(() => {
    let cancelled = false;
    fetch('/rooms/rooms.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<RoomPreset[]>;
      })
      .then((data) => {
        if (cancelled) return;
        const looksValid =
          Array.isArray(data) &&
          data.length > 0 &&
          data.every(
            (r) =>
              r !== null &&
              typeof r === 'object' &&
              typeof r.id === 'string' &&
              typeof r.src === 'string' &&
              Array.isArray(r.wall) &&
              r.wall.length === 4,
          );
        if (!looksValid) {
          setRoomsFailed(true);
          return;
        }
        setRooms(data);
        setRoomId((cur) => cur ?? data[0]!.id);
      })
      .catch(() => {
        if (!cancelled) setRoomsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // quad для комнаты: сохранённая подгонка или дефолт пресета.
  // Читается в обработчиках (не в effect — react-hooks/set-state-in-effect).
  function quadForRoom(rid: string): QuadN {
    try {
      const raw = window.localStorage.getItem(`wallviz:${slug}:${rid}`);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (isValidQuadN(parsed)) return parsed;
      }
    } catch {
      // private mode / битый JSON — тихо берём дефолт пресета
    }
    const preset = rooms?.find((r) => r.id === rid);
    return presetToQuadN((preset ?? { wall: [[0, 0], [0, 0], [0, 0], [0, 0]] }).wall);
  }

  // Смена комнаты — в обработчике клика: сразу и roomId, и quad.
  function selectRoom(rid: string): void {
    setRoomId(rid);
    setQuadN(quadForRoom(rid));
  }

  // Esc + блокировка скролла body — паттерн app/components/Modal.tsx.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  // Фокус на крестике при открытии.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Размер бокса фото в px: useLayoutEffect + ResizeObserver на wrapper.
  // useLayoutEffect (не useEffect): измеряем ДО первой отрисовки слоёв.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (el === null) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showStage]);

  // Нормализованный quad пресета → px бокса фото; вся математика дальше в px.
  const quadPx = useMemo<Quad | null>(
    () => (quadN === null || box.w <= 0 || box.h <= 0 ? null : toPx(quadN, box)),
    [quadN, box],
  );

  // bbox quad — размер обоев-div до трансформации.
  const bbox = useMemo<{ w: number; h: number } | null>(() => {
    if (quadPx === null) return null;
    const xs = quadPx.map((p) => p.x);
    const ys = quadPx.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return w > 0 && h > 0 ? { w, h } : null;
  }, [quadPx]);

  // Единичный прямоугольник bbox → quad; вырожденный quad даёт null —
  // слой обоев просто не рендерится.
  const homog = useMemo(
    () => (quadPx === null || bbox === null ? null : homography(quadPx, bbox)),
    [quadPx, bbox],
  );
  const clipPath = useMemo(() => (quadPx === null ? null : clipPathForQuad(quadPx)), [quadPx]);

  // Масштаб: px/м = средняя высота quad / высота стены от слайдера;
  // полоса обоев на экране = ширина рулона (м) × px/м.
  const rollWidthCm = rollSize === null ? FALLBACK_ROLL_CM : rollSize.widthCm;
  const pxPerMeter = quadPx === null ? 0 : avgHeightPx(quadPx) / wallHeightM;
  const stripPx = (rollWidthCm / 100) * pxPerMeter;
  const wallWidth = quadPx === null ? 0 : wallWidthM(quadPx, wallHeightM);
  const strips = stripsForWall(wallWidth, rollWidthCm);

  const persistQuad = useCallback(
    (q: QuadN, rid: string) => {
      try {
        window.localStorage.setItem(`wallviz:${slug}:${rid}`, JSON.stringify(q));
      } catch {
        // private mode — молча без сохранения
      }
    },
    [slug],
  );

  // Сохранение подгонки: любая смена quad → localStorage (private mode — тихо).
  useEffect(() => {
    if (roomId !== null && quadN !== null) persistQuad(quadN, roomId);
  }, [quadN, roomId, persistQuad]);

  const setCorner = (i: number, p: Point): void => {
    setQuadN((prev) =>
      prev === null
        ? prev
        : (prev.map((q, idx) => (idx === i ? p : q)) as QuadN),
    );
  };

  const normFromEvent = (e: ReactPointerEvent<HTMLButtonElement>): Point | null => {
    const el = stageRef.current;
    if (el === null) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clampN((e.clientX - rect.left) / rect.width),
      y: clampN((e.clientY - rect.top) / rect.height),
    };
  };

  const onHandlePointerDown = (i: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragIndex(i);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onHandlePointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragIndex === null) return;
    const i = dragIndex;
    const p = normFromEvent(e);
    if (p !== null) setCorner(i, p);
  };

  const onHandlePointerFinish = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragIndex === null) return;
    setDragIndex(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Клавиатура: стрелки двигают угол на 0.01 нормализованных координат.
  const onHandleKeyDown = (i: number) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const deltas: Record<string, Point> = {
      ArrowLeft: { x: -KEY_STEP, y: 0 },
      ArrowRight: { x: KEY_STEP, y: 0 },
      ArrowUp: { x: 0, y: -KEY_STEP },
      ArrowDown: { x: 0, y: KEY_STEP },
    };
    const delta = deltas[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    if (quadN === null) return;
    const cur = quadN[i]!;
    setCorner(i, { x: clampN(cur.x + delta.x), y: clampN(cur.y + delta.y) });
  };

  // «Скинути» — дефолтный quad пресета.
  const resetQuad = (): void => {
    if (room === null) return;
    setQuadN(presetToQuadN(room.wall));
  };

  // «До калькулятора»: закрыть модалку и скроллить к калькулятору,
  // только если он на странице.
  const goToCalculator = (): void => {
    onClose();
    document.getElementById('roll-calculator')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Візуалізатор шпалер в інтер'єрі"
      className="fixed inset-0 z-50 flex overscroll-contain items-end justify-center bg-black/80 sm:items-center sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Внутренний скролл на мобильном: панель не выше 100dvh */}
      <div className="flex max-h-[100dvh] w-full max-w-3xl flex-col overflow-y-auto rounded-t-2xl bg-white shadow-lg sm:rounded-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-4 py-1 sm:px-6">
          <h2 className="text-lg font-bold text-gray-900">{"Подивитись в інтер'єрі"}</h2>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            aria-label="Закрити"
            className="flex h-11 w-11 items-center justify-center rounded text-2xl leading-none text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors motion-reduce:transition-none"
          >
            ×
          </button>
        </div>

        {roomsFailed ? (
          <div className="flex flex-col items-center gap-4 p-8 text-center">
            <p className="text-base text-gray-700">
              Не вдалося завантажити приміщення. Спробуйте пізніше.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] rounded-lg border border-gray-300 px-6 text-base font-medium text-gray-700 hover:bg-gray-50 transition-colors motion-reduce:transition-none"
            >
              Закрити
            </button>
          </div>
        ) : !showStage ? (
          <div className="flex min-h-[40dvh] items-center justify-center p-8">
            <p className="text-base text-gray-500">Завантаження…</p>
          </div>
        ) : (
          <>
            <div className="p-3 sm:p-6">
              {/* Фото комнаты: бокс измеряется, quad хранится нормализованным */}
              <div ref={stageRef} className="relative select-none">
                {/* eslint-disable-next-line @next/next/no-img-element -- бокс <img> измеряется ResizeObserver-ом; статика /public */}
          <img
                  src={room!.src}
                  alt={room!.label}
                  draggable={false}
                  className="block w-full"
                />
                {quadPx !== null && clipPath !== null && homog !== null && bbox !== null && (
                  <>
                    {/* Шпалера: clip-path режет повторяющийся фон по quad */}
                    <div className="absolute inset-0" style={{ clipPath }}>
                      <div
                        className="absolute left-0 top-0"
                        style={{
                          width: bbox.w,
                          height: bbox.h,
                          backgroundImage: `url("${textureUrl}")`,
                          backgroundRepeat: 'repeat',
                          backgroundSize: `${stripPx}px auto`,
                          transform: homog.css,
                          transformOrigin: '0 0',
                        }}
                      />
                    </div>
                    {/* 4 угловые ручки: 44px, pointer capture, клавиатура.
                        Развернуты явно (не .map) — статический инвариант
                        теста считает тап-зоны ≥44px по исходнику. */}
                    <button
                      type="button"
                      aria-label="Кут стіни — лівий верхній"
                      onPointerDown={onHandlePointerDown(0)}
                      onPointerMove={onHandlePointerMove}
                      onPointerUp={onHandlePointerFinish}
                      onPointerCancel={onHandlePointerFinish}
                      onKeyDown={onHandleKeyDown(0)}
                      className="absolute h-11 w-11 touch-none rounded-full border-2 border-white bg-blue-600/70 shadow-md transition-transform hover:bg-blue-600 focus-visible:outline-2 focus-visible:outline-blue-700 motion-reduce:transition-none"
                      style={{ left: quadPx[0]!.x, top: quadPx[0]!.y, transform: 'translate(-50%, -50%)' }}
                    />
                    <button
                      type="button"
                      aria-label="Кут стіни — правий верхній"
                      onPointerDown={onHandlePointerDown(1)}
                      onPointerMove={onHandlePointerMove}
                      onPointerUp={onHandlePointerFinish}
                      onPointerCancel={onHandlePointerFinish}
                      onKeyDown={onHandleKeyDown(1)}
                      className="absolute h-11 w-11 touch-none rounded-full border-2 border-white bg-blue-600/70 shadow-md transition-transform hover:bg-blue-600 focus-visible:outline-2 focus-visible:outline-blue-700 motion-reduce:transition-none"
                      style={{ left: quadPx[1]!.x, top: quadPx[1]!.y, transform: 'translate(-50%, -50%)' }}
                    />
                    <button
                      type="button"
                      aria-label="Кут стіни — правий нижній"
                      onPointerDown={onHandlePointerDown(2)}
                      onPointerMove={onHandlePointerMove}
                      onPointerUp={onHandlePointerFinish}
                      onPointerCancel={onHandlePointerFinish}
                      onKeyDown={onHandleKeyDown(2)}
                      className="absolute h-11 w-11 touch-none rounded-full border-2 border-white bg-blue-600/70 shadow-md transition-transform hover:bg-blue-600 focus-visible:outline-2 focus-visible:outline-blue-700 motion-reduce:transition-none"
                      style={{ left: quadPx[2]!.x, top: quadPx[2]!.y, transform: 'translate(-50%, -50%)' }}
                    />
                    <button
                      type="button"
                      aria-label="Кут стіни — лівий нижній"
                      onPointerDown={onHandlePointerDown(3)}
                      onPointerMove={onHandlePointerMove}
                      onPointerUp={onHandlePointerFinish}
                      onPointerCancel={onHandlePointerFinish}
                      onKeyDown={onHandleKeyDown(3)}
                      className="absolute h-11 w-11 touch-none rounded-full border-2 border-white bg-blue-600/70 shadow-md transition-transform hover:bg-blue-600 focus-visible:outline-2 focus-visible:outline-blue-700 motion-reduce:transition-none"
                      style={{ left: quadPx[3]!.x, top: quadPx[3]!.y, transform: 'translate(-50%, -50%)' }}
                    />
                  </>
                )}
                <span className="absolute bottom-2 left-2 rounded-full bg-black/50 px-2.5 py-1 text-xs font-medium text-white">
                  {room!.label}
                </span>
              </div>

              {/* Выбор комнаты — 4 миниатюры пресетов */}
              {rooms !== null && (
                <div className="mt-3 grid grid-cols-4 gap-2">
                  {rooms.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => selectRoom(r.id)}
                      aria-pressed={r.id === roomId}
                      className={`min-h-[44px] rounded-lg border p-1 transition-colors motion-reduce:transition-none ${
                        r.id === roomId
                          ? 'border-blue-600 ring-1 ring-blue-600'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- миниатюра пресета, статика /public */}
                      <img src={r.src} alt="" className="h-12 w-full rounded object-cover" />
                      <span className="mt-1 block text-xs text-gray-600">{r.label}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Слайдер задаёт физический масштаб стены (метры) */}
              <label className="mt-4 block">
                <span className="mb-1 block text-sm font-medium text-gray-700">
                  Висота стіни: {formatM(wallHeightM)} м
                </span>
                <input
                  type="range"
                  min="2"
                  max="3.5"
                  step="0.05"
                  value={wallHeightM}
                  onChange={(e) => setWallHeightM(Number(e.target.value))}
                  className="w-full text-base"
                />
              </label>

              {rollSize === null && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Розмір рулона не вказано в назві — масштаб орієнтовний (ширина 53 см).
                </p>
              )}
            </div>

            {/* Футер: смуги + действия */}
            <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 bg-white px-4 py-3 sm:px-6">
              <p className="text-sm font-medium text-gray-900">
                ≈ {strips} {stripsLabel(strips)} для цієї стіни
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={resetQuad}
                  className="min-h-[44px] rounded-lg border border-gray-300 px-4 text-base font-medium text-gray-700 hover:bg-gray-50 transition-colors motion-reduce:transition-none"
                >
                  Скинути
                </button>
                <button
                  type="button"
                  onClick={goToCalculator}
                  className="min-h-[44px] rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700 transition-colors motion-reduce:transition-none"
                >
                  До калькулятора
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
