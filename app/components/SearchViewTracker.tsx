'use client';

import { useEffect } from 'react';
import { track } from '@vercel/analytics';
import { ANALYTICS_EVENTS, sanitizeSearchQuery } from '@/app/lib/analytics';

/**
 * Search analytics island. Renders nothing.
 *
 * Rendered by the catalog page ONLY when a search term is applied. The
 * server passes the raw term; here it goes through the PII sanitizer
 * (emails/phone-shaped input dropped, length capped) before the `search`
 * event is sent. No result counts, no user identifiers.
 */
export default function SearchViewTracker({ query }: { query?: string }) {
  useEffect(() => {
    if (!query) return;
    const clean = sanitizeSearchQuery(query);
    if (clean) {
      track(ANALYTICS_EVENTS.SEARCH, { query: clean });
    }
  }, [query]);

  return null;
}
