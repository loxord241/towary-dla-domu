'use client';

import { useEffect } from 'react';
import { track } from '@vercel/analytics';
import {
  readRecentlyViewed,
  writeRecentlyViewed,
  recordRecentlyViewed,
} from '@/app/lib/recently-viewed-storage';
import { ANALYTICS_EVENTS } from '@/app/lib/analytics';

/**
 * Invisible recorder: adds the currently open product to the
 * recently-viewed list. Runs exclusively inside an effect (after
 * hydration) and always renders null, so server and client markup match
 * exactly — no hydration mismatch is possible.
 */
export default function RecentlyViewedTracker({ productId }: { productId: string }) {
  useEffect(() => {
    // Anonymous page-view analytics: product UUID only, no PII.
    track(ANALYTICS_EVENTS.PRODUCT_VIEW, { product_id: productId });

    const current = readRecentlyViewed((key) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    });
    writeRecentlyViewed(
      (key, value) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // quota/private-mode failures leave storage untouched
        }
      },
      recordRecentlyViewed(current, productId)
    );
  }, [productId]);

  return null;
}
