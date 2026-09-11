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
 * UX: long descriptions start collapsed to a ~4-line preview with a
 * «Показати більше» toggle; short ones render fully with no button.
 * Collapse/expand is the project's reference accordion pattern (CSS
 * grid-rows 0fr<->1fr trick, see CheckoutForm) since 2026-09-08 — the
 * old max-h-24 clamp snapped height abruptly. SSR markup ships the
 * collapsed preview by default; measurement after first paint corrects
 * short texts (median supplier description is ~1200 chars, so
 * default-collapsed is correct for the vast majority).
 */

/** Гистерезис сверх превью (96px ≈ 4 строки × line-height 24px — первая
 * track-строка аккордеона grid-rows-[96px_0fr] ниже), чтобы пограничные
 * тексты не мигали кнопкой. */
const COLLAPSE_EXTRA_PX = 8;

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
      // 2026-09-08 (аудит анимаций №6): замер переполнения перенесён на
      // ВНУТРЕННИЙ контейнер аккордеона (row-span-2 min-h-0 overflow-
      // hidden): в свёрнутом виде его clientHeight = превью (96px),
      // scrollHeight = полная высота контента → кнопка появляется только
      // если контент реально переполняет превью (логика сохранена).
      const el = contentRef.current;
      setCollapsible(
        el ? el.scrollHeight - el.clientHeight > COLLAPSE_EXTRA_PX : true
      );
    });
    return () => cancelAnimationFrame(id);
  }, [resolved.value]);

  const isHtml = resolved.kind === 'html';
  const clamped = isHtml && collapsible && !expanded;
  // Аккордеон считается открытым и для коротких (неклампируемых) текстов —
  // иначе после замера короткий опис мигнул бы превью-стрижкой.
  const open = expanded || !collapsible;

  return (
    <div>
      {isHtml ? (
        <div>
          <div className="relative">
            {/* 2026-09-08 (аудит анимаций №6): резкий кламп max-h-24 →
                эталонный аккордеон-паттерн проекта (grid-rows 0fr<->1fr,
                см. CheckoutForm): обёртка всегда смонтирована, высота
                интерполируется плавно. Отличие от эталона вынужденное:
                здесь свёрнутое состояние — превью 96px + невидимый
                остаток (96px_0fr), а НЕ 0fr/invisible, ведь превью и
                градиент обязаны оставаться видимыми (один
                dangerouslySetInnerHTML нельзя «показать наполовину»
                через visibility). Механика та же: обе track-пары
                интерполируются (px→px, fr→fr), высота растёт/падает
                плавно 96px ↔ полная; `visibility` в transition-списке —
                сигнатура паттерна (обе ветки visible, скрытие остатка
                делает overflow-hidden). Tab в свёрнутом виде убирает
                `inert` на внутреннем контейнере: обрезанный остаток и
                превью-ссылки не ловят фокус (visibility не умеет
                «спрятать половину» одного элемента). */}
            <div
              className={
                'grid transition-[grid-template-rows,visibility] duration-250 ease-out motion-reduce:transition-none ' +
                (open
                  ? 'grid-rows-[0fr_1fr] visible'
                  : 'grid-rows-[96px_0fr] visible')
              }
            >
              <div
                ref={contentRef}
                inert={!open}
                className="row-span-2 min-h-0 overflow-hidden"
              >
                <div
                  // The single controlled dangerouslySetInnerHTML of the project.
                  // Content source: sanitized-at-import products.description.
                  dangerouslySetInnerHTML={{ __html: resolved.value }}
                  className={
                    // wrap-anywhere: постачальницький HTML містить довгі
                    // нерозривні токени; у згорнутому превʼю (обгортка
                    // overflow-hidden) інакше вони обрізаються по краю.
                    `wrap-anywhere ${RICH_TYPOGRAPHY} ` +
                    (clamped
                      ? // Collapsed preview: wide <table>s are squeezed to
                        // the container width in the preview (3 supplier
                        // descriptions START with a table — without this
                        // they get ugly-clipped at the right edge with no
                        // scrollbar). Expanded state keeps the proper
                        // overflow-x-auto table scrolling.
                        '[&_table]:max-w-full [&_table]:w-full'
                      : 'overflow-x-auto')
                  }
                />
              </div>
            </div>
            {/* Градиент-заглушка свёрнутого превью: всегда в DOM ради
                opacity-перехода, в раскрытом виде прозрачна. */}
            <div
              aria-hidden="true"
              className={
                'pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-transparent transition-opacity duration-250 motion-reduce:transition-none ' +
                (clamped ? 'opacity-100' : 'opacity-0')
              }
            />
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
