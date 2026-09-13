'use client';

import { useEffect } from 'react';
import { trackEvent } from '@/app/lib/track-event';
import {
  ANALYTICS_EVENTS,
  TRAFFIC_SOURCE_STORAGE_KEY,
  classifyTrafficSource,
  resolveFirstTouchSource,
} from '@/app/lib/analytics';

/**
 * First-touch traffic source capture. Renders nothing.
 *
 * Runs once per full page load: classifies the visitor's arrival
 * (utm_source wins, then document.referrer, then direct) and persists the
 * FIRST touch source anonymously in localStorage. Only the very first
 * visit fires a `traffic_source` event with the source class — no URLs,
 * no user agents, no identifiers, no cookies. Internal navigation is
 * ignored entirely.
 */
export default function TrafficSourceTracker() {
  useEffect(() => {
    const read = (): string | null => {
      try {
        return window.localStorage.getItem(TRAFFIC_SOURCE_STORAGE_KEY);
      } catch {
        return null;
      }
    };
    const write = (value: string): void => {
      try {
        window.localStorage.setItem(TRAFFIC_SOURCE_STORAGE_KEY, value);
      } catch {
        // quota/private-mode failures must never break the page
      }
    };

    const utmSource = new URLSearchParams(window.location.search).get('utm_source');
    const candidate = classifyTrafficSource({
      referrer: document.referrer,
      currentHost: window.location.host,
      utmSource,
    });

    const { source, isFirstTouch } = resolveFirstTouchSource(read, write, candidate);
    if (isFirstTouch && source) {
      trackEvent(ANALYTICS_EVENTS.TRAFFIC_SOURCE, { source });
    }
  }, []);

  return null;
}
