'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import {
  CART_STORAGE_KEY,
  MAX_CART_LINES,
  MAX_ITEM_QUANTITY,
  UUID_RE,
  clampQuantity,
  lineKey,
  sanitizeStoredCart,
  type CartItem,
} from '@/app/lib/cart-storage';

/**
 * Client-side cart. localStorage stores ONLY product/variant identifiers
 * and quantity — never prices, names, stock or totals (see cart-storage).
 * Every money value shown comes from the server (/api/cart-preview); the
 * final pricing authority is place_order() in PostgreSQL.
 */

interface CartState {
  items: CartItem[];
  hydrated: boolean;
}

type CartAction =
  | { type: 'HYDRATE'; items: CartItem[] }
  | { type: 'ADD_ITEM'; item: CartItem }
  | { type: 'REMOVE_ITEM'; key: string }
  | { type: 'UPDATE_QUANTITY'; key: string; quantity: number }
  | { type: 'CLEAR' };

// Module-scope loader keeps all state updates inside async callbacks so no
// setState happens synchronously within the hydration effect body.
// EVERYTHING runs inside the try/catch (localStorage access, JSON.parse,
// sanitize) so hydration is guaranteed to terminate with hydrated=true:
// blocked storage, broken JSON and corrupted shapes all degrade to an
// empty cart instead of leaving the UI waiting forever.
async function loadStoredCart(onItems: (items: CartItem[]) => void) {
  let sanitized: CartItem[] = [];
  try {
    const stored = window.localStorage.getItem(CART_STORAGE_KEY);
    const parsed = stored === null ? [] : JSON.parse(stored);
    sanitized = sanitizeStoredCart(parsed);
  } catch {
    sanitized = []; // broken JSON or blocked storage -> start clean
  }
  onItems(sanitized);
}

function reducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'HYDRATE':
      return { items: action.items, hydrated: true };
    case 'ADD_ITEM': {
      const key = lineKey(action.item.productId, action.item.variantId);
      const items = [...state.items];
      const idx = items.findIndex(
        (i) => lineKey(i.productId, i.variantId) === key
      );
      if (idx !== -1) {
        items[idx] = {
          ...items[idx],
          quantity: Math.min(MAX_ITEM_QUANTITY, items[idx].quantity + action.item.quantity),
        };
      } else if (items.length < MAX_CART_LINES) {
        items.push(action.item);
      } else {
        return state;
      }
      return { ...state, items };
    }
    case 'REMOVE_ITEM':
      return {
        ...state,
        items: state.items.filter(
          (i) => lineKey(i.productId, i.variantId) !== action.key
        ),
      };
    case 'UPDATE_QUANTITY': {
      const qty = clampQuantity(action.quantity);
      if (qty === null) return state;
      return {
        ...state,
        items: state.items.map((i) =>
          lineKey(i.productId, i.variantId) === action.key
            ? { ...i, quantity: qty }
            : i
        ),
      };
    }
    case 'CLEAR':
      return { items: [], hydrated: true };
    default:
      return state;
  }
}

interface CartContextValue {
  items: CartItem[];
  /** false until localStorage has been read — prevents SSR hydration mismatch */
  hydrated: boolean;
  addItem: (productId: string, variantId: string | null, quantity?: number) => void;
  removeItem: (productId: string, variantId: string | null) => void;
  updateQuantity: (
    productId: string,
    variantId: string | null,
    quantity: number
  ) => void;
  clearCart: () => void;
  getItemQuantity: (productId: string, variantId: string | null) => number;
  totalCount: number;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    items: [],
    hydrated: false,
  });

  useEffect(() => {
    let cancelled = false;
    loadStoredCart((loadedItems) => {
      if (!cancelled) dispatch({ type: 'HYDRATE', items: loadedItems });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!state.hydrated) return;
    try {
      window.localStorage.setItem(
        CART_STORAGE_KEY,
        JSON.stringify(state.items)
      );
    } catch {
      // storage blocked/full — cart still works in memory for this session
    }
  }, [state]);

  const value = useMemo<CartContextValue>(() => {
    const indexOf = (productId: string, variantId: string | null) =>
      state.items.findIndex(
        (i) =>
          lineKey(i.productId, i.variantId) === lineKey(productId, variantId)
      );
    return {
      items: state.items,
      hydrated: state.hydrated,
      addItem: (productId, variantId, quantity = 1) => {
        const qty = clampQuantity(quantity);
        if (qty === null || !UUID_RE.test(productId)) return;
        if (variantId !== null && !UUID_RE.test(variantId)) return;
        dispatch({
          type: 'ADD_ITEM',
          item: { productId, variantId, quantity: qty },
        });
      },
      removeItem: (productId, variantId) => {
        dispatch({
          type: 'REMOVE_ITEM',
          key: lineKey(productId, variantId),
        });
      },
      updateQuantity: (productId, variantId, quantity) => {
        dispatch({
          type: 'UPDATE_QUANTITY',
          key: lineKey(productId, variantId),
          quantity,
        });
      },
      clearCart: () => dispatch({ type: 'CLEAR' }),
      getItemQuantity: (productId, variantId) => {
        const idx = indexOf(productId, variantId);
        return idx === -1 ? 0 : state.items[idx].quantity;
      },
      totalCount: state.items.reduce((sum, i) => sum + i.quantity, 0),
    };
  }, [state]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export { MAX_CART_LINES, MAX_ITEM_QUANTITY, type CartItem };

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
