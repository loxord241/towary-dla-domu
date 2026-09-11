'use client';

import { Suspense, useRef, useState, type ComponentType } from 'react';
import type { RollSize } from '@/app/lib/wallpapers/parse';
import type { WallVisualizerProps } from './WallVisualizer';

/**
 * Ленивый слот визуализатора на PDP: рендерит только кнопку-открывашку.
 * Сама модалка тянется отдельным чанком по клику (ручной dynamic import —
 * НЕ next/dynamic, чтобы не зависеть от его поведения в Server Components);
 * import type выше стирается при компиляции и чанк не склеивает.
 */
export default function WallVisualizerSlot({
  textureUrl,
  rollSize,
  slug,
}: {
  textureUrl: string;
  rollSize: RollSize | null;
  slug: string;
}) {
  const [open, setOpen] = useState(false);
  const [Visualizer, setVisualizer] = useState<ComponentType<WallVisualizerProps> | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  // Пустой URL (неразрешимое фото) — блок не рендерится вовсе.
  if (!textureUrl) return null;

  const openModal = async (): Promise<void> => {
    setOpen(true);
    if (Visualizer !== null) return;
    try {
      const { default: WallVisualizer } = await import('./WallVisualizer');
      setVisualizer(() => WallVisualizer);
    } catch {
      // чанк не догрузился — тихо возвращаемся к кнопке
      setOpen(false);
    }
  };

  const close = (): void => {
    setOpen(false);
    // Возврат фокуса на кнопку открытия (spec §2.7).
    openerRef.current?.focus();
  };

  return (
    <>
      <button
        type="button"
        ref={openerRef}
        onClick={() => {
          void openModal();
        }}
        className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-base font-medium text-blue-700 transition-colors hover:bg-blue-100 motion-reduce:transition-none"
      >
        {/* иконка комнаты */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5 shrink-0"
          aria-hidden="true"
        >
          <path d="M3 11 12 3l9 8" />
          <path d="M5 9.5V21h14V9.5" />
          <rect x="9.5" y="13" width="5" height="8" rx="0.5" />
        </svg>
        {"Подивитись в інтер'єрі"}
      </button>

      {open && (
        <Suspense fallback={<VisualizerFallback />}>
          {Visualizer === null ? (
            <VisualizerFallback />
          ) : (
            <Visualizer
              textureUrl={textureUrl}
              rollSize={rollSize}
              slug={slug}
              onClose={close}
            />
          )}
        </Suspense>
      )}
    </>
  );
}

/** Фоллбек на время ленивой подгрузки модалки. */
function VisualizerFallback() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" role="status">
      <p className="rounded-lg bg-white px-6 py-4 text-base text-gray-700">Завантаження…</p>
    </div>
  );
}
