'use client';

import Link from 'next/link';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

/**
 * Shared pagination navigation for the three storefronts (/catalog,
 * /oboi, /linoleum) — owner P1 fix 2026-09-18 (dead/rage clicks on
 * /catalog/shpaleri-flizelin?page=3, Clarity-confirmed, Firefox+Chrome).
 *
 * Navigation mode: DOCUMENT navigation (window.location.assign), owner
 * revision 2026-09-18. Soft navigation lost to the same segment-cache
 * race that broke sorting (owner bug 2026-09-15, isSortDocumentNavigation
 * in app/lib/filter-url.ts): a static prefetch of the ISR path is cached
 * REUSABLY ACROSS ALL search param values (Next 16.3.5 segment cache,
 * vary-path.ts «Static prefetches never include search params»), and any
 * other link on the storefront (chips, header) warms that entry — so a
 * soft navigation to ?page=N could still render the previous page's
 * products under the new URL. A document navigation always reaches the
 * server: proxy.ts rewrites the query-carrying URL to the force-dynamic
 * twin, which renders the requested page.
 *
 * What the component still owns:
 *  - Pre-unload feedback (owner requirement: the user must SEE the click
 *    land): the clicked control dims (opacity-50 + pointer-events-none)
 *    and the server-rendered products grid — outside this component — is
 *    dimmed via its anchor element (opacity-60 + pointer-events-none).
 *    React flushes the state update and the effect mutates the DOM before
 *    the browser tears the page down (navigation itself is async).
 *  - Native behavior for modified clicks (ctrl/cmd/shift/alt, other
 *    buttons): «открыть в новой вкладке» keeps working — those clicks are
 *    never intercepted.
 *  - prefetch={false} on every pagination link: each paginated href would
 *    otherwise fire an RSC request (a real twin render per link in view)
 *    that a document navigation never uses.
 *  - P3-R2 untouched: the inactive prev/next side is a span with
 *    aria-disabled (no link, announced unavailable) that also LOOKS dead
 *    on mobile (opacity-30 + pointer-events-none). The current page stays
 *    an aria-current span; numbers come from buildPageWindow — assembled
 *    by the server storefront and passed in as items.
 *
 * Server storefronts keep the URL logic (catalogPageUrl/oboiPageUrl/
 * linoleumPageUrl) and the button geometry classes — this component only
 * owns the interaction.
 */

/** Toggled on the grid anchor from the click until the page unloads. */
const GRID_PENDING_CLASSES = ['opacity-60', 'pointer-events-none'] as const;

export type PaginationNavItem =
  | { kind: 'page'; page: number; href: string }
  | { kind: 'ellipsis' };

export interface PaginationNavProps {
  /** href of the previous page, or null when already on page 1. */
  prevHref: string | null;
  /** href of the next page, or null when already on the last page. */
  nextHref: string | null;
  /** Numbered window (±2 + first/last with ellipsis gaps) with hrefs. */
  items: PaginationNavItem[];
  /** The page the server actually rendered (aria-current, not a link). */
  currentPage: number;
  /** id of the products grid: the pre-unload dimming target. */
  anchorId: string;
  /** Button geometry — each storefront passes its pinned classes. */
  controlClassName: string;
  pageLinkClassName: string;
  currentPageClassName: string;
  ellipsisClassName: string;
  /** Server-rendered «Сторінка X із Y · знайдено N» status node. */
  status: ReactNode;
}

export default function PaginationNav({
  prevHref,
  nextHref,
  items,
  currentPage,
  anchorId,
  controlClassName,
  pageLinkClassName,
  currentPageClassName,
  ellipsisClassName,
  status,
}: PaginationNavProps) {
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const navigateToPage =
    (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
      // Native behavior for modified clicks / other buttons / already
      // handled events — «open in new tab» must keep working.
      if (event.defaultPrevented) return;
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      // Pre-unload feedback: set state FIRST, then navigate — React flushes
      // the update (and the dimming effect below) before the async
      // navigation tears the page down, so the user sees the click land.
      setPendingHref(href);
      window.location.assign(href);
    };

  // Pre-unload dimming on the server-rendered grid: the grid lives outside
  // this component, so the classes are toggled on its anchor element
  // directly (a client component may touch its own document).
  useEffect(() => {
    if (pendingHref === null) return;
    const anchor = document.getElementById(anchorId);
    if (!anchor) return;
    anchor.classList.add(...GRID_PENDING_CLASSES);
    return () => {
      anchor.classList.remove(...GRID_PENDING_CLASSES);
    };
  }, [pendingHref, anchorId]);

  const pendingClass = (href: string) =>
    pendingHref === href ? ' opacity-50 pointer-events-none' : '';

  return (
    <nav
      aria-label="Пагінація"
      aria-busy={pendingHref !== null || undefined}
      className="mt-6 flex flex-wrap items-center justify-center gap-2 sm:gap-3"
    >
      {prevHref !== null ? (
        <Link
          href={prevHref}
          prefetch={false}
          aria-label="Попередня сторінка"
          className={controlClassName + pendingClass(prevHref)}
          onClick={navigateToPage(prevHref)}
        >
          ← Назад
        </Link>
      ) : (
        <span
          aria-disabled="true"
          className={`${controlClassName} opacity-30 pointer-events-none`}
        >
          ← Назад
        </span>
      )}
      {items.map((item, idx) =>
        item.kind === 'ellipsis' ? (
          <span
            key={`gap-${idx}`}
            aria-hidden="true"
            className={ellipsisClassName}
          >
            …
          </span>
        ) : item.page === currentPage ? (
          <span
            key={`page-${item.page}`}
            aria-current="page"
            className={currentPageClassName}
          >
            {item.page}
          </span>
        ) : (
          <Link
            key={`page-${item.page}`}
            href={item.href}
            prefetch={false}
            aria-label={`Сторінка ${item.page}`}
            className={pageLinkClassName + pendingClass(item.href)}
            onClick={navigateToPage(item.href)}
          >
            {item.page}
          </Link>
        )
      )}
      {status}
      {nextHref !== null ? (
        <Link
          href={nextHref}
          prefetch={false}
          aria-label="Наступна сторінка"
          className={controlClassName + pendingClass(nextHref)}
          onClick={navigateToPage(nextHref)}
        >
          Далі →
        </Link>
      ) : (
        <span
          aria-disabled="true"
          className={`${controlClassName} opacity-30 pointer-events-none`}
        >
          Далі →
        </span>
      )}
    </nav>
  );
}
