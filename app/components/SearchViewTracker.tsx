'use client';

import { useEffect } from 'react';
import { trackEvent } from '@/app/lib/track-event';
import { ANALYTICS_EVENTS, buildSearchEventPayload } from '@/app/lib/analytics';

/**
 * Search analytics island. Renders nothing.
 *
 * Rendered by the catalog page ONLY when a search term is applied. The
 * server passes the raw term plus a boolean `hasResults` (whether the
 * rendered search view had any products — typo-fallback hits count as
 * results). The payload is built by the pure buildSearchEventPayload:
 * the raw term goes through the PII sanitizer (emails/phone-shaped input
 * dropped, length capped) before the `search` event is sent, and a null
 * payload means NO event is fired at all. No result counts (only a
 * boolean hasResults), no user identifiers.
 */
export default function SearchViewTracker({
  query,
  hasResults,
}: {
  query?: string;
  hasResults: boolean;
}) {
  useEffect(() => {
    if (!query) return;
    const payload = buildSearchEventPayload(query, hasResults);
    if (payload) {
      trackEvent(ANALYTICS_EVENTS.SEARCH, payload);
    }
  }, [query, hasResults]);

  return null;
}
