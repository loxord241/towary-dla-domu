'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

export interface LightboxImage {
  url: string;
  alt: string;
}

interface LightboxProps {
  images: LightboxImage[];
  /** Slide to open the overlay on (clamped into range). */
  initialIndex: number;
  onClose: () => void;
}

/**
 * Fullscreen photo lightbox for the PDP gallery (owner task 2026-09-11).
 *
 * Overlay: fixed inset-0 bg-black/90, image contained; closes via ✕,
 * Escape or a backdrop click; ‹/› buttons (plus ArrowLeft/ArrowRight) and
 * horizontal touch swipes (|Δx| > 40px) walk the gallery images when there
 * is more than one. The overlay keeps its OWN
 * index: flipping photos here must not replay the gallery fade behind it.
 *
 * Motion: keyframe entry (fade on the overlay, fade+zoom settle on the
 * image) defined in globals.css @layer components — transform/opacity only,
 * disabled with motion-reduce:animate-none; exit stays instant (unmount).
 *
 * A11y: role="dialog" + aria-modal, initial focus on the close button,
 * body scroll lock while open, alt text inherited from the gallery image.
 */
export default function Lightbox({
  images,
  initialIndex,
  onClose,
}: LightboxProps) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(initialIndex, 0), Math.max(images.length - 1, 0))
  );
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // Swipe support: clientX where the current touch started (null = no swipe).
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);

  const hasMany = images.length > 1;
  const current = images[index];

  // The same walkers the ‹/› arrows use (also bound to the swipe handlers).
  const prev = () => setIndex((i) => (i - 1 + images.length) % images.length);
  const next = () => setIndex((i) => (i + 1) % images.length);

  const onTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    touchStartXRef.current = event.touches[0]?.clientX ?? null;
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  };

  const onTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const startX = touchStartXRef.current;
    touchStartXRef.current = null;
    const endX = event.changedTouches[0]?.clientX;
    if (startX === null || endX === undefined || !hasMany) return;
    const deltaX = endX - startX;
    const startY = touchStartYRef.current;
    const endY = event.changedTouches[0]?.clientY;
    const diagonal = startY !== null && endY !== undefined && Math.abs(endY - startY) >= Math.abs(deltaX);
    if (Math.abs(deltaX) > 40 && !diagonal) {
      if (deltaX < 0) next();
      else prev();
    }
  };

  // Initial focus: the close button is the overlay's primary action.
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  // Body scroll lock while the overlay is open (restored on unmount).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      } else if (hasMany && event.key === 'ArrowLeft') {
        setIndex((i) => (i - 1 + images.length) % images.length);
      } else if (hasMany && event.key === 'ArrowRight') {
        setIndex((i) => (i + 1) % images.length);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, hasMany, images.length]);

  // Defensive: the gallery never mounts the lightbox with zero images.
  if (!current) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Перегляд фото товару"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="lightbox-fade motion-reduce:animate-none fixed inset-0 z-50 flex overscroll-contain items-center justify-center bg-black/90 p-4"
    >
      <button
        type="button"
        ref={closeBtnRef}
        onClick={onClose}
        aria-label="Закрити"
        className="absolute right-[max(1rem,env(safe-area-inset-right))] top-[max(1rem,env(safe-area-inset-top))] flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/10 text-2xl leading-none text-white hover:bg-white/20 transition-colors motion-reduce:transition-none"
      >
        ✕
      </button>

      {hasMany && (
        <button
          type="button"
          aria-label="Попереднє фото"
          onClick={prev}
          className="absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-3xl leading-none text-white hover:bg-white/20 transition-colors motion-reduce:transition-none"
        >
          ‹
        </button>
      )}

      <Image
        key={current.url}
        src={current.url}
        alt={current.alt}
        width={1600}
        height={1200}
        sizes="100vw"
        className="lightbox-zoom motion-reduce:animate-none h-auto max-h-[85dvh] w-auto max-w-full object-contain"
      />

      {hasMany && (
        <button
          type="button"
          aria-label="Наступне фото"
          onClick={next}
          className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-3xl leading-none text-white hover:bg-white/20 transition-colors motion-reduce:transition-none"
        >
          ›
        </button>
      )}

      {hasMany && (
        <span
          aria-hidden="true"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2.5 py-1 text-xs font-medium text-white"
        >
          {index + 1} / {images.length}
        </span>
      )}
    </div>
  );
}
