'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * «Поділитися» row on the product page (SEO package 2026-09-13): Viber,
 * Telegram and copy-to-clipboard. Client island — only the copy button
 * needs state; Viber/Telegram are plain deep-link anchors. `url` and
 * `title` arrive as serializable props from the server page (built from
 * NEXT_PUBLIC_SITE_URL, the same basis as the JSON-LD builders), so this
 * component reads no env/config itself.
 *
 * Touch contract: every control is min-h-[44px] with its own aria-label.
 */

const COPIED_RESET_MS = 2000;

function ViberIcon({ className }: { className?: string }) {
  // Stroke phone-in-speech-bubble mark (project icon set is stroke-based).
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      className={className}
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
      <path d="M9 10a.5.5 0 0 0 1 0V9a1 1 0 0 0-1-1 7 7 0 0 0-1 1c0 4 2.5 6.5 6.5 6.5a7 7 0 0 0 1-1 1 1 0 0 0-1-1h-1a.5.5 0 0 0 0 1" />
    </svg>
  );
}

function TelegramIcon({ className }: { className?: string }) {
  // Paper-plane mark (stroke style, same geometry family as the icon set).
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      className={className}
    >
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      className={className}
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

const shareButtonClass =
  'inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-blue-700 motion-reduce:transition-none';

export default function ShareButtons({
  url,
  title,
}: {
  /** Absolute product URL (NEXT_PUBLIC_SITE_URL basis, built by the page). */
  url: string;
  /** Product name as it should appear in the shared message. */
  title: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmount hygiene: never let a pending reset touch state afterwards.
  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    []
  );

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(
        () => setCopied(false),
        COPIED_RESET_MS
      );
    } catch {
      // Clipboard can be unavailable (permission denied, insecure context):
      // sharing is an affordance, not a critical path — fail silently.
    }
  }

  // Viber forwards one combined message; Telegram takes url and text apart.
  const viberHref = `viber://forward?text=${encodeURIComponent(
    `${title} — ${url}`
  )}`;
  const telegramHref = `https://t.me/share/url?url=${encodeURIComponent(
    url
  )}&text=${encodeURIComponent(title)}`;

  return (
    <div className="mb-6">
      <p className="mb-2 text-sm font-medium text-gray-700">Поділитися:</p>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={viberHref}
          aria-label="Поділитися у Viber"
          className={shareButtonClass}
        >
          <ViberIcon className="h-4 w-4" />
          Viber
        </a>
        <a
          href={telegramHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Поділитися в Telegram"
          className={shareButtonClass}
        >
          <TelegramIcon className="h-4 w-4" />
          Telegram
        </a>
        <button
          type="button"
          onClick={copyLink}
          aria-label="Копіювати посилання"
          aria-pressed={copied}
          className={shareButtonClass}
        >
          <LinkIcon className="h-4 w-4" />
          {copied ? 'Скопійовано' : 'Копіювати посилання'}
        </button>
      </div>
      {/* Screen-reader confirmation: the visible label swap is inside a
          button whose aria-label stays stable, so announce it explicitly. */}
      <span role="status" className="sr-only">
        {copied ? 'Посилання скопійовано' : ''}
      </span>
    </div>
  );
}
