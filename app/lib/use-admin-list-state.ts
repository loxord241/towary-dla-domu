'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AdminListUrlState {
  search: string;
  sort: string;
  page: number;
}

const DEFAULT_STATE: AdminListUrlState = { search: '', sort: 'default', page: 1 };
const SEARCH_DEBOUNCE_MS = 300;

function readFromLocation(): AdminListUrlState {
  if (typeof window === 'undefined') return { ...DEFAULT_STATE };
  const params = new URLSearchParams(window.location.search);
  const pageParam = Number(params.get('page'));
  return {
    search: params.get('search') ?? '',
    sort: params.get('sort') ?? 'default',
    page: Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1,
  };
}

/**
 * URL-backed search/sort/page state for admin list pages.
 *
 * - Search/sort/page live in the URL: refresh, Back/Forward (popstate) and
 *   shareable links all preserve the filtered view.
 * - Typing is debounced; a NEW committed search always resets page to 1 —
 *   the old page number has no meaning for a different result set.
 * - All state transitions run from timers/event callbacks (never
 *   synchronously inside an effect body).
 */
export function useAdminListUrlState(allowedSorts: readonly string[]) {
  const [urlState, setUrlState] = useState<AdminListUrlState>({ ...DEFAULT_STATE });
  const [ready, setReady] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const skipPushRef = useRef(false);

  const applyLocation = useCallback(() => {
    const parsed = readFromLocation();
    skipPushRef.current = true; // restoring a URL that already exists
    setUrlState({
      search: parsed.search,
      sort: allowedSorts.includes(parsed.sort) ? parsed.sort : 'default',
      page: parsed.page,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initial hydration from the current URL (deferred out of the effect
  // body) + Back/Forward restoration.
  useEffect(() => {
    const timer = setTimeout(() => {
      applyLocation();
      setReady(true);
    }, 0);
    window.addEventListener('popstate', applyLocation);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('popstate', applyLocation);
    };
  }, [applyLocation]);

  // Every user-driven state change pushes a shareable URL entry.
  useEffect(() => {
    if (!ready) return;
    if (skipPushRef.current) {
      skipPushRef.current = false;
      return;
    }
    const qs = new URLSearchParams();
    if (urlState.search !== '') qs.set('search', urlState.search);
    if (urlState.sort !== 'default' && allowedSorts.includes(urlState.sort)) {
      qs.set('sort', urlState.sort);
    }
    if (urlState.page > 1) qs.set('page', String(urlState.page));
    const query = qs.toString();
    window.history.pushState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, urlState]);

  // Debounced typing → URL state.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim();
      setUrlState((prev) =>
        prev.search === next ? prev : { ...prev, search: next, page: 1 }
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // External URL changes (Back/Forward, initial hydration) sync back into
  // the input field.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchInput((prev) => (prev === urlState.search ? prev : urlState.search));
    }, 0);
    return () => clearTimeout(timer);
  }, [urlState.search]);

  const patchUrlState = useCallback((patch: Partial<AdminListUrlState>) => {
    setUrlState((prev) => ({ ...prev, ...patch }));
  }, []);

  return { ready, urlState, patchUrlState, searchInput, setSearchInput };
}
