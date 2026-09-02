import type { ReactNode } from 'react';
import SiteHeader from '@/app/components/SiteHeader';
import SiteFooter from '@/app/components/SiteFooter';
import Announcements from '@/app/components/Announcements';

// Cart is a private localStorage-driven surface: keep it out of search
// indexes entirely (SEO package 2026-08-26, spec E).
export const metadata = {
  robots: { index: false, follow: false },
};

// Shared shell: the header/footer live here so the announcements banner
// (server component) can render between the header and the cart UI —
// the page itself is a client component and cannot host it directly.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <SiteHeader />
      <Announcements />
      <div className="flex-1">{children}</div>
      <SiteFooter />
    </div>
  );
}
