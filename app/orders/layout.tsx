import type { ReactNode } from 'react';

// Guest order lookup and token-gated order views contain personal purchase
// data — never index either route (layout covers /orders/* including
// lookup and [orderNumber]; SEO package 2026-08-26, spec E).
export const metadata = {
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
