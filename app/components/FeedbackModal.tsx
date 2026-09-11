'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { XIcon } from './icons';
import {
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_MIN_LENGTH,
} from '@/app/lib/feedback';
import { CONTACT_EMAIL } from '@/app/lib/site';

/**
 * Anonymous feedback modal, opened from the footer. Collects ONLY the
 * message text (plus a hidden honeypot field for bots). The submit target
 * answers 501 until feedback storage is approved and connected — the UI
 * shows an honest "not available yet" state instead of a fake success.
 *
 * Animation contract (parity with NavDrawer / CatalogFilters and the
 * ReviewFormModal): on OPEN the overlay fades in (`opacity`, 200ms) while
 * the panel fades + scales in (`opacity` + `scale`, 95%→100%, ~200ms) —
 * pure CSS transitions, no layout impact, CLS 0. Exit stays instant
 * (immediate unmount, same convention as the SiteHeader items).
 * `prefers-reduced-motion` gets an instant show
 * (`motion-reduce:transition-none`). Focus trap, scroll lock, dialog
 * semantics and the honeypot are unaffected.
 */

type Status = 'idle' | 'sending' | 'success' | 'error';
type ErrorKind = 'unconfigured' | 'rate' | 'generic';

export default function FeedbackModal({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  // `shown` drives the entry transition: the modal mounts hidden, then the
  // double-rAF flip below starts the overlay fade + panel scale-in.
  const [shown, setShown] = useState(false);
  const [text, setText] = useState('');
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorKind, setErrorKind] = useState<ErrorKind>('generic');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const trimmedLength = text.trim().length;
  const canSubmit =
    trimmedLength >= FEEDBACK_MIN_LENGTH && trimmedLength <= FEEDBACK_MAX_LENGTH;

  const onClose = useCallback(() => {
    setOpen(false);
    // Reset so the NEXT open animates again; the current modal unmounts
    // instantly (no exit choreography — see the animation contract above).
    setShown(false);
    setStatus('idle');
    setErrorKind('generic');
    setText('');
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
          'a[href], button:not([disabled]), textarea'
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
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, website }),
      });
      if (res.status === 201) {
        setStatus('success');
      } else if (res.status === 429) {
        setErrorKind('rate');
        setStatus('error');
      } else {
        // 503: storage not configured yet; anything else: transient failure
        setErrorKind(res.status === 503 ? 'unconfigured' : 'generic');
        setStatus('error');
      }
    } catch {
      setErrorKind('generic');
      setStatus('error');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[44px] items-center hover:text-white hover:underline"
      >
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
            aria-label="Зворотний зв'язок"
            className={`relative max-h-[100dvh] w-full max-w-md overflow-y-auto rounded-t-xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl transition-[opacity,scale] duration-200 ease-out motion-reduce:transition-none sm:rounded-xl ${
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
                Дякуємо за відгук!
              </p>
            ) : (
              <form onSubmit={submit} noValidate>
                <label
                  htmlFor="feedback-message"
                  className="mb-1 block text-sm text-gray-600"
                >
                  Ваша пропозиція
                </label>
                <textarea
                  id="feedback-message"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={5}
                  maxLength={FEEDBACK_MAX_LENGTH}
                  required
                  className="w-full rounded-lg border border-gray-300 p-3 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500"
                  placeholder="Що можна покращити?"
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
                <div className="mt-1 flex items-center justify-between text-xs text-gray-400">
                  <span>
                    Відгук надсилається анонімно — без імені, email чи інших
                    даних.
                  </span>
                  <span>
                    {trimmedLength}/{FEEDBACK_MAX_LENGTH}
                  </span>
                </div>

                {status === 'error' && (
                  <p className="mt-2 text-sm text-red-600" role="alert">
                    {errorKind === 'rate'
                      ? 'Сьогодні вже багато відгуків — спробуйте, будь ласка, завтра.'
                      : errorKind === 'unconfigured'
                        ? `Помилка: прийом відгуків ще не підключено. Напишіть нам на ${CONTACT_EMAIL}.`
                        : `Помилка надсилання. Спробуйте ще раз або напишіть на ${CONTACT_EMAIL}.`}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={!canSubmit || status === 'sending'}
                  className="btn btn-primary mt-4 w-full disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === 'sending' ? 'Надсилаємо...' : 'Надіслати'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
