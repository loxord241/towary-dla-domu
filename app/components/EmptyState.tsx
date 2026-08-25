import Link from 'next/link';
import type { ReactNode } from 'react';
import { BoxIcon } from './icons';

/**
 * Consistent empty-state block: icon, title, optional description and CTA.
 */
export default function EmptyState({
  icon = <BoxIcon className="h-10 w-10" />,
  title,
  description,
  ctaHref,
  ctaLabel,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  ctaHref?: string;
  ctaLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white px-6 py-14 text-center shadow-sm">
      {icon && (
        <div aria-hidden className="mb-3 opacity-70">
          {icon}
        </div>
      )}
      <p className="text-lg font-semibold text-gray-900">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-gray-500">{description}</p>
      )}
      {ctaHref && ctaLabel && (
        <Link href={ctaHref} className="btn btn-primary mt-5">
          {ctaLabel}
        </Link>
      )}
      {children}
    </div>
  );
}
