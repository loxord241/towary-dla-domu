'use client';

import { useState } from 'react';
import Image from 'next/image';

export interface GalleryImage {
  url: string;
  alt: string;
}

/**
 * Interactive product gallery: main image + clickable thumbnails.
 * Falls back to a placeholder tile when there are no images at all.
 *
 * Motion (2026-09 animation batch, group C): the main image fades in
 * (opacity-only, 200ms) after a user-driven switch. The initial render
 * carries NO animation classes — that image is the preloaded LCP element
 * of the PDP (stage 14), so it must paint immediately.
 */
export default function ProductGallery({ images }: { images: GalleryImage[] }) {
  const [selected, setSelected] = useState(0);
  // User-driven selection counter; 0 means "initial render" — the fade gate.
  const [changeCount, setChangeCount] = useState(0);
  // URL of the image that is fully visible: the initial one, or one whose
  // keyed remount has finished loading (fade-in completes on onLoad).
  const [settledUrl, setSettledUrl] = useState(images[0]?.url ?? null);

  const selectImage = (next: (current: number) => number) => {
    setSelected(next);
    setChangeCount((c) => c + 1);
  };

  if (images.length === 0) {
    return (
      <div className="bg-gray-200 border-2 border-dashed rounded-xl w-full h-96 flex items-center justify-center">
        <span className="text-gray-500">Фото відсутнє</span>
      </div>
    );
  }

  const main = images[Math.min(selected, images.length - 1)]!;
  // Fade gate: the motion classes exist ONLY after the first user-driven
  // switch. On the first render this evaluates to '' — no transition, no
  // opacity delay, the preloaded LCP image paints instantly.
  const mainMotion =
    changeCount > 0
      ? `transition-opacity duration-200 ease-out motion-reduce:transition-none ${
          settledUrl === main.url ? 'opacity-100' : 'opacity-0'
        }`
      : '';

  return (
    <div>
      <div className="relative">
        {/* Above-the-fold LCP image: preload inserts a <head> link so the
            fetch starts before hydration (Next 16 replacement for the
            deprecated `priority` prop; 2026-08 UX audit + perf audit).
            key={main.url} remounts the element per selection so the
            opacity fade replays for every switch (opacity only — the fixed
            h-96 box keeps layout identical, zero CLS). */}
        <Image
          key={main.url}
          src={main.url}
          alt={main.alt}
          width={960}
          height={768}
          preload
          sizes="(max-width: 768px) 100vw, (max-width: 1024px) 100vw, 50vw"
          onLoad={() => setSettledUrl(main.url)}
          onError={() => setSettledUrl(main.url)}
          className={`w-full h-96 object-contain ${mainMotion}`}
        />
        {images.length > 1 && (
          <span className="absolute bottom-2 right-2 rounded-full bg-black/50 px-2.5 py-1 text-xs font-medium text-white">
            {Math.min(selected, images.length - 1) + 1} / {images.length}
          </span>
        )}
        {images.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Попереднє фото"
              onClick={() =>
                selectImage((s) => (s - 1 + images.length) % images.length)
              }
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/80 rounded-full w-9 h-9 shadow hover:bg-white transition-colors motion-reduce:transition-none"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Наступне фото"
              onClick={() => selectImage((s) => (s + 1) % images.length)}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/80 rounded-full w-9 h-9 shadow hover:bg-white transition-colors motion-reduce:transition-none"
            >
              ›
            </button>
          </>
        )}
      </div>

      {images.length > 1 && (
        <div className="flex gap-2 mt-3 p-1 -mx-1 overflow-x-auto">
          {/* p-1 gives the selected ring room inside the scroll clip box on
              all sides (ring is a 1px box-shadow OUTSIDE the border-box; with
              zero padding overflow-x:auto clipped its top/left/right lines).
              mt-3+pt-1 keep the previous 16px top gap; -mx-1 keeps the
              strip's outer edges aligned with the main image. */}
          {images.map((img, idx) => (
            <button
              key={img.url}
              type="button"
              aria-label={`Фото ${idx + 1}`}
              aria-current={idx === selected}
              onClick={() => selectImage(() => idx)}
              className={`shrink-0 rounded border transition-colors motion-reduce:transition-none ${
                idx === selected
                  ? 'border-blue-600 ring-1 ring-blue-400'
                  : 'border-gray-200 hover:border-gray-400'
              }`}
            >
              <Image
                src={img.url}
                alt={img.alt}
                width={80}
                height={80}
                sizes="80px"
                className="w-20 h-20 object-cover rounded"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
