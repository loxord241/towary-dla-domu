'use client';

import { useEffect, useRef, useState } from 'react';
import { XIcon } from './icons';

/**
 * Post-checkout notice: shown once the order confirmation page has loaded
 * with a verified order. Purely informational — no requests, no server
 * state. Styled after FeedbackModal (bottom sheet on mobile, centered from
 * sm up).
 */
export default function ShippingPeriodNotice() {
  const [open, setOpen] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = '';
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shipping-period-title"
        className="relative w-full max-w-md rounded-t-xl bg-white p-5 shadow-xl sm:rounded-xl"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 id="shipping-period-title" className="text-lg font-semibold text-gray-900">
            Термін відправлення
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label="Закрити вікно"
            onClick={() => setOpen(false)}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        <p className="text-sm leading-relaxed text-gray-700">
          Період відправлення замовлення від 3 до 5 робочих днів.
        </p>

        <button
          type="button"
          onClick={() => setOpen(false)}
          className="btn btn-primary mt-4 w-full"
        >
          Продовжити
        </button>
      </div>
    </div>
  );
}
