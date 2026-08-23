/**
 * Shared client contract for /api/cart-preview plus the ONLY way pages may
 * call it. The fetcher is time-bounded: every run settles within
 * PREVIEW_TIMEOUT_MS and always ends in onDone(), so a stalled mobile
 * network can never leave a page in an endless loading state.
 *
 * No DOM usage — importable and testable in plain Node.
 */

export interface PreviewRequestItem {
  productId: string;
  variantId: string | null;
}

/** Shape returned by POST /api/cart-preview for each requested line. */
export interface CartPreviewLine {
  productId: string;
  variantId: string | null;
  found: boolean;
  name: string | null;
  slug: string | null;
  variantName: string | null;
  unitPrice: number | null;
  currency: string | null;
  stock: number | null;
  availabilityStatus: string | null;
  imageUrl: string | null;
}

/**
 * Hard upper bound for request + response body. Generous enough for slow
 * mobile links, short enough that a stalled socket cannot freeze a page.
 */
export const PREVIEW_TIMEOUT_MS = 12_000;

/** Shown when the request is aborted by the timeout or effect cleanup. */
export const PREVIEW_NETWORK_ERROR =
  'Немає з’єднання з сервером. Перевірте інтернет і спробуйте ще раз.';

const DEFAULT_URL = '/api/cart-preview';

interface FetchHandlers {
  onData: (lines: CartPreviewLine[]) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

/**
 * POSTs identifier-only items to /api/cart-preview. Never throws; handlers
 * fire at most once each unless dispose() is called first — after dispose()
 * nothing fires at all (the caller has moved on / unmounted).
 *
 * Returns a dispose function that aborts an in-flight request. Call it from
 * effect cleanup so superseded requests stop consuming the radio.
 */
export function fetchCartPreview(
  items: PreviewRequestItem[],
  handlers: FetchHandlers,
  options: { url?: string; timeoutMs?: number } = {}
): () => void {
  const { onData, onError, onDone } = handlers;
  const url = options.url ?? DEFAULT_URL;
  const timeoutMs = options.timeoutMs ?? PREVIEW_TIMEOUT_MS;

  let disposed = false;
  const skip = (call: () => void) => {
    if (!disposed) call();
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  void (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => null)) as
        | { items?: CartPreviewLine[]; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error || 'Не вдалося завантажити дані');
      }
      skip(() => onData(Array.isArray(data?.items) ? data.items : []));
    } catch (err) {
      skip(() => {
        if (controller.signal.aborted) {
          onError(PREVIEW_NETWORK_ERROR);
        } else {
          onError(err instanceof Error ? err.message : 'Помилка завантаження');
        }
      });
    } finally {
      clearTimeout(timer);
      skip(onDone);
    }
  })();

  return () => {
    disposed = true;
    clearTimeout(timer);
    controller.abort();
  };
}
