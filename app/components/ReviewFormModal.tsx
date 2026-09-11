'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { StarIcon, XIcon } from './icons';
import {
  REVIEW_MAX_LENGTH,
  REVIEW_MIN_LENGTH,
  REVIEW_NAME_MAX_LENGTH,
} from '@/app/lib/reviews';

/**
 * «Залишити відгук» modal on the product page. Collects ONLY rating, text
 * and an optional display name (plus the hidden honeypot field). The server
 * puts the review into the pending queue; the success state promises
 * moderation explicitly — we never imply instant publication.
 *
 * Animation contract (parity with NavDrawer / CatalogFilters): on OPEN the
 * overlay fades in (`opacity`, 200ms) while the panel fades + scales in
 * (`opacity` + `scale`, 95%→100%, ~200ms) — pure CSS transitions, no layout
 * impact, CLS 0. Exit stays instant (immediate unmount, same convention as
 * the SiteHeader items). `prefers-reduced-motion` gets an instant show
 * (`motion-reduce:transition-none`). Focus trap, scroll lock, dialog
 * semantics and the honeypot are unaffected.
 */

type Status = 'idle' | 'sending' | 'success' | 'error';
type ErrorKind = 'unconfigured' | 'rate' | 'generic';

export default function ReviewFormModal({
  label,
  productId,
}: {
  label: string;
  productId: string;
}) {
  const [open, setOpen] = useState(false);
  // `shown` drives the entry transition: the modal mounts hidden, then the
  // double-rAF flip below starts the overlay fade + panel scale-in.
  const [shown, setShown] = useState(false);
  const [rating, setRating] = useState(0);
  const [hoveredRating, setHoveredRating] = useState(0);
  const [text, setText] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorKind, setErrorKind] = useState<ErrorKind>('generic');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const trimmedLength = text.trim().length;
  const canSubmit =
    rating >= 1 &&
    trimmedLength >= REVIEW_MIN_LENGTH &&
    trimmedLength <= REVIEW_MAX_LENGTH;

  const onClose = useCallback(() => {
    setOpen(false);
    // Reset so the NEXT open animates again; the current modal unmounts
    // instantly (no exit choreography — see the animation contract above).
    setShown(false);
    setStatus('idle');
    setErrorKind('generic');
    setRating(0);
    setHoveredRating(0);
    setText('');
    setDisplayName('');
    setWebsite('');
  }, []);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea, input:not([type="hidden"])'
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
  }, [open, onClose]);

  // Entry flip: commit the hidden initial styles (overlay opacity-0, panel
  // opacity-0 scale-95) first, then flip `shown` on the next frames so the
  // CSS transition actually animates. State flips stay inside rAF (never
  // synchronously in the effect body) per the project-wide react-hooks rule
  // — same pattern as NavDrawer.
  useEffect(() => {
    if (!open) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || status === 'sending') return;
    setStatus('sending');
    setErrorKind('generic');
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId,
          rating,
          text,
          displayName: displayName.trim() === '' ? undefined : displayName.trim(),
          website,
        }),
      });
      if (res.status === 201) {
        setStatus('success');
      } else if (res.status === 429) {
        setErrorKind('rate');
        setStatus('error');
      } else {
        // 503: storage not connected yet; anything else: transient failure.
        setErrorKind(res.status === 503 ? 'unconfigured' : 'generic');
        setStatus('error');
      }
    } catch {
      setErrorKind('generic');
      setStatus('error');
    }
  };

  const shownRating = hoveredRating > 0 ? hoveredRating : rating;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn btn-primary">
        {label}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <div
            className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
              shown ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
            onClick={onClose}
            aria-hidden
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className={`relative max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl transition-[opacity,scale] duration-200 ease-out motion-reduce:transition-none sm:rounded-xl ${
              shown ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
            }`}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900">{label}</h2>
              <button
                ref={closeBtnRef}
                type="button"
                aria-label="Закрити вікно"
                onClick={onClose}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            {status === 'success' ? (
              <p className="py-6 text-center text-sm text-green-700" role="status">
                Дякуємо! Відгук надіслано та очікує модерації.
              </p>
            ) : (
              <form onSubmit={submit} noValidate>
                <fieldset className="mb-4 border-0 p-0">
                  <legend className="mb-2 text-sm text-gray-600">Оцінка</legend>
                  <div
                    className="flex gap-1"
                    role="radiogroup"
                    aria-label="Оцінка від 1 до 5"
                  >
                    {[1, 2, 3, 4, 5].map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={rating === value}
                        aria-label={`${value} з 5`}
                        onMouseEnter={() => setHoveredRating(value)}
                        onMouseLeave={() => setHoveredRating(0)}
                        onClick={() => setRating(value)}
                        className={`rounded p-1.5 transition-colors ${
                          value <= shownRating ? 'text-amber-500' : 'text-gray-300'
                        } hover:text-amber-400`}
                      >
                        <StarIcon
                          className="h-8 w-8"
                          filled={value <= shownRating}
                        />
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label htmlFor="review-name" className="mb-1 block text-sm text-gray-600">
                  Ім&apos;я (необов&apos;язково)
                </label>
                <input
                  id="review-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={REVIEW_NAME_MAX_LENGTH}
                  autoComplete="off"
                  className="mb-3 w-full rounded-lg border border-gray-300 p-2.5 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500"
                  placeholder="Наприклад: Оксана"
                />

                <label htmlFor="review-text" className="mb-1 block text-sm text-gray-600">
                  Ваш відгук
                </label>
                <textarea
                  id="review-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={5}
                  maxLength={REVIEW_MAX_LENGTH}
                  required
                  className="w-full rounded-lg border border-gray-300 p-3 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500"
                  placeholder="Поділіться враженнями про товар…"
                />

                {/* honeypot — invisible to humans, bots fill it */}
                <input
                  type="text"
                  name="website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  className="hidden"
                />

                <div className="mt-1 flex items-center justify-between gap-3 text-xs text-gray-400">
                  <span>Відгук публікується після перевірки модератором.</span>
                  <span>
                    {trimmedLength}/{REVIEW_MAX_LENGTH}
                  </span>
                </div>

                {status === 'error' && (
                  <p className="mt-2 text-sm text-red-600" role="alert">
                    {errorKind === 'rate'
                      ? 'Зараз надто багато відгуків — спробуйте, будь ласка, пізніше.'
                      : errorKind === 'unconfigured'
                        ? 'Прийом відгуків ще не підключено — спробуйте пізніше.'
                        : 'Перевірте оцінку та текст (від 10 символів) і спробуйте ще раз.'}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={!canSubmit || status === 'sending'}
                  className="btn btn-primary mt-4 w-full disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === 'sending' ? 'Надсилаємо...' : 'Надіслати відгук'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
