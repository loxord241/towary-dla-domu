'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { resolveProductDescription } from '@/app/lib/product-description';

/**
 * Controlled HTML rendering for products.description.
 *
 * SECURITY INVARIANT: description arrives ALREADY SANITIZED by the
 * allowlist sanitizer at import/staging time (app/lib/yugcontract/
 * content-sanitize.ts) — no client-side sanitization happens or is
 * needed here. This component is the ONLY place in the project allowed
 * to use dangerouslySetInnerHTML, and only for this field.
 *
 * UX: long descriptions start collapsed (~4 lines) with a
 * «Показати більше» toggle; short ones render fully with no button.
 * The clamp is applied in SSR markup by default and removed after
 * measurement for short texts (median supplier description is ~1200
 * chars, so default-collapsed is correct for the vast majority).
 */

/** ≈4 строки (line-height 24px × 4). */
const COLLAPSE_HEIGHT_PX = 96;
/** Гистерезис, чтобы пограничные тексты не мигали кнопкой. */
const COLLAPSE_THRESHOLD_PX = COLLAPSE_HEIGHT_PX + 8;

/**
 * Scoped typography for sanitized supplier HTML. Tailwind arbitrary
 * variants keep the styles local to this block (no global CSS):
 * readable tables without page-wide horizontal overflow on mobile and
 * images that never escape their container.
 */
const RICH_TYPOGRAPHY =
  'text-gray-700 ' +
  '[&_p]:my-2 [&_div]:my-1 [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:mt-4 [&_h4]:mb-1 [&_h4]:font-semibold ' +
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 ' +
  '[&_strong]:font-semibold [&_b]:font-semibold [&_em]:italic [&_i]:italic [&_u]:underline ' +
  '[&_img]:mx-auto [&_img]:block [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded ' +
  '[&_table]:w-full [&_table]:border-collapse [&_table]:my-3 [&_th]:border [&_th]:border-gray-300 [&_th]:bg-gray-50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-gray-300 [&_td]:px-2 [&_td]:py-1';

export default function ProductDescription({
  description,
  shortDescription,
}: {
  description?: string | null;
  shortDescription?: string | null;
}): ReactNode {
  const resolved = resolveProductDescription(description, shortDescription);
  const showSecondaryShort =
    resolved.kind === 'html' && (shortDescription?.trim() ?? '') !== '';

  const contentRef = useRef<HTMLDivElement | null>(null);
  // SSR/initial: assume the html block needs collapsing (correct for the
  // median supplier description); the effect below corrects short ones.
  const [collapsible, setCollapsible] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // Measure after paint (rAF): keeps the lint rule happy and lets the
    // browser lay out the sanitized HTML before we decide on collapsing.
    const id = requestAnimationFrame(() => {
      setExpanded(false);
      const el = contentRef.current;
      setCollapsible(el ? el.scrollHeight > COLLAPSE_THRESHOLD_PX : true);
    });
    return () => cancelAnimationFrame(id);
  }, [resolved.value]);

  const isHtml = resolved.kind === 'html';
  const clamped = isHtml && collapsible && !expanded;

  return (
    <div>
      {isHtml ? (
        <div>
          <div className="relative">
            <div
              ref={contentRef}
              // The single controlled dangerouslySetInnerHTML of the project.
              // Content source: sanitized-at-import products.description.
              dangerouslySetInnerHTML={{ __html: resolved.value }}
              className={
                `${RICH_TYPOGRAPHY} ` +
                (clamped
                  ? // Collapsed preview: fixed height, hidden overflow.
                    // Wide <table>s are squeezed to the container width in
                    // the preview (3 supplier descriptions START with a
                    // table — without this they get ugly-clipped at the
                    // right edge with no scrollbar). Expanded state keeps
                    // the proper overflow-x-auto table scrolling.
                    'max-h-24 overflow-hidden [&_table]:max-w-full [&_table]:w-full'
                  : 'overflow-x-auto')
              }
            />
            {clamped && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-transparent"
              />
            )}
          </div>
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded"
            >
              {expanded ? 'Згорнути' : 'Показати більше'}
              <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
            </button>
          )}
        </div>
      ) : (
        <p className="whitespace-pre-line text-gray-700">{resolved.value}</p>
      )}
      {showSecondaryShort && (
        <p className="mt-2 text-sm text-gray-500">{shortDescription}</p>
      )}
    </div>
  );
}
