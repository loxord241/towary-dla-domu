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
 */
export default function ProductGallery({ images }: { images: GalleryImage[] }) {
  const [selected, setSelected] = useState(0);

  if (images.length === 0) {
    return (
      <div className="bg-gray-200 border-2 border-dashed rounded-xl w-full h-96 flex items-center justify-center">
        <span className="text-gray-500">Фото відсутнє</span>
      </div>
    );
  }

  const main = images[Math.min(selected, images.length - 1)];

  return (
    <div>
      <div className="relative">
        {/* Above-the-fold LCP image: priority disables the default lazy-load
            and adds fetchpriority=high (2026-08 UX audit). */}
        <Image
          src={main.url}
          alt={main.alt}
          width={960}
          height={768}
          priority
          unoptimized
          className="w-full h-96 object-contain"
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
                setSelected((s) => (s - 1 + images.length) % images.length)
              }
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/80 rounded-full w-9 h-9 shadow hover:bg-white"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Наступне фото"
              onClick={() => setSelected((s) => (s + 1) % images.length)}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/80 rounded-full w-9 h-9 shadow hover:bg-white"
            >
              ›
            </button>
          </>
        )}
      </div>

      {images.length > 1 && (
        <div className="flex gap-2 mt-4 overflow-x-auto pb-1">
          {images.map((img, idx) => (
            <button
              key={img.url}
              type="button"
              aria-label={`Фото ${idx + 1}`}
              aria-current={idx === selected}
              onClick={() => setSelected(idx)}
              className={`shrink-0 rounded border ${
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
                unoptimized
                className="w-20 h-20 object-cover rounded"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
