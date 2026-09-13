'use client';

import { track as vercelTrack } from '@vercel/analytics';

/**
 * Single fan-out point for the six anonymous storefront events: every
 * caller previously hit @vercel/analytics directly; since the GA4 stage
 * (owner task 2026-09-13, «пакет А») the same event also goes to
 * window.gtag when GA4 is configured (WebAnalytics sets it from
 * NEXT_PUBLIC_GA4_ID). Both backends stay identifier-free — payloads are
 * the audited anonymous ones from app/lib/analytics.ts. Never throws.
 */
export function trackEvent(name: string, payload?: Record<string, unknown>) {
  try {
    vercelTrack(name, payload as Parameters<typeof vercelTrack>[1]);
  } catch {
    // Vercel Analytics unavailable (adblock/offline) — GA4 still gets the event.
  }
  if (typeof window === 'undefined') return;
  const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  if (typeof gtag === 'function') {
    try {
      gtag('event', name, payload ?? {});
    } catch {
      // GA4 misconfigured — never break the storefront over telemetry.
    }
  }
}
