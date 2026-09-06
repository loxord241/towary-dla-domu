'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  FAVORITES_STORAGE_KEY,
  MAX_FAVORITES,
  sanitizeStoredFavorites,
} from '@/app/lib/favorites-storage';

/**
 * Client-side favorites. localStorage stores ONLY product ids — no names,
 * prices or stock. Display data comes from the server (/api/cart-preview
 * reused for batch lookup on /favorites).
 */

interface FavoritesState {
  ids: string[];
  hydrated: boolean;
}

// Module-scope loader keeps state updates inside async callbacks (project
// react-hooks pattern — no synchronous setState in effect bodies).
// EVERYTHING runs inside the try/catch (localStorage access, JSON.parse,
// sanitize) so hydration is guaranteed to terminate with hydrated=true:
// blocked storage, broken JSON and corrupted shapes all degrade to an
// empty list instead of leaving the UI waiting forever.
// Exported so behavioral tests can exercise it directly (node:test does not
// render React).
export async function loadStoredFavorites(onIds: (ids: string[]) => void) {
  let sanitized: string[] = [];
  try {
    const stored = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    const parsed = stored === null ? [] : JSON.parse(stored);
    sanitized = sanitizeStoredFavorites(parsed);
  } catch {
    sanitized = []; // broken JSON or blocked storage -> start clean
  }
  onIds(sanitized);
}

interface FavoritesContextValue {
  ids: string[];
  /** false until localStorage has been read — prevents SSR hydration mismatch */
  hydrated: boolean;
  isFavorite: (productId: string) => boolean;
  /** true when the toggle actually changed the list; false at the MAX cap. */
  toggleFavorite: (productId: string) => boolean;
  removeFavorite: (productId: string) => void;
  clearFavorites: () => void;
  totalCount: number;
}

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

/**
 * Pure core of toggleFavorite, extracted (behavior unchanged) so node:test
 * can cover the cap/remove/add transitions without rendering React.
 * Returns the next ids list, or null when the toggle is a no-op (id absent
 * and the list is already at the MAX_FAVORITES cap). Input is never mutated.
 */
export function toggleFavoriteList(
  ids: string[],
  productId: string
): string[] | null {
  if (ids.includes(productId)) {
    return ids.filter((id) => id !== productId);
  }
  if (ids.length >= MAX_FAVORITES) return null;
  return [...ids, productId];
}

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FavoritesState>({
    ids: [],
    hydrated: false,
  });
  const { ids, hydrated } = state;

  useEffect(() => {
    let cancelled = false;
    loadStoredFavorites((loaded) => {
      if (!cancelled) setState({ ids: loaded, hydrated: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // storage blocked/full — favorites still work in memory this session
    }
  }, [ids, hydrated]);

  const value = useMemo<FavoritesContextValue>(() => {
    const set = new Set(ids);
    return {
      ids,
      hydrated,
      isFavorite: (productId) => set.has(productId),
      toggleFavorite: (productId) => {
        // toggleFavoriteList returns null exactly when the id is absent and
        // the list is already at MAX_FAVORITES — mirror that drop condition
        // so callers can tell a real toggle from a silent no-op at the cap.
        if (toggleFavoriteList(ids, productId) === null) return false;
        setState((prev) => {
          const next = toggleFavoriteList(prev.ids, productId);
          return next === null ? prev : { ...prev, ids: next };
        });
        return true;
      },
      removeFavorite: (productId) => {
        setState((prev) => ({
          ...prev,
          ids: prev.ids.filter((id) => id !== productId),
        }));
      },
      clearFavorites: () => setState((prev) => ({ ...prev, ids: [] })),
      totalCount: ids.length,
    };
  }, [ids, hydrated]);

  return (
    <FavoritesContext.Provider value={value}>
      {children}
    </FavoritesContext.Provider>
  );
}

export { MAX_FAVORITES };

export function useFavorites(): FavoritesContextValue {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error('useFavorites must be used within FavoritesProvider');
  return ctx;
}
