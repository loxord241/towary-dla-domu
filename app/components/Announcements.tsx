import { fetchActiveAnnouncements } from '@/app/lib/announcements-store';
import {
  ANNOUNCEMENT_TYPE_META,
  type AnnouncementType,
} from '@/app/lib/announcements';
import {
  InfoIcon,
  WarningIcon,
  ImportantIcon,
  SuccessIcon,
} from './icons';

/**
 * Store announcements banner (migration 031) — compact centered
 * notification strips, mounted below SiteHeader on home, catalog, PDP and
 * cart. In-flow only (never fixed/overlay): content is pushed down,
 * navigation stays clear.
 *
 * Geometry contract — a small notification badge, not a full-width alert
 * banner: the outer div only positions (slim px-3 gutter, so mobile strips
 * span ~calc(100% - 24px)); each visual strip is `w-full sm:w-fit` with a
 * 720px desktop cap and `mx-auto` centering. Desktop renders ONE line —
 * [icon] Title · Message — at ≈50px tall; on mobile the message wraps to
 * its own line. No shadows, no label. Several active announcements stack
 * as independent centered strips (space-y-2), ordered by sort_order.
 *
 * By type (accent, not fill):
 *  - info:      subtle blue;
 *  - warning:   near-white ORANGE background, thin orange border/accent —
 *               amber visually blended with the gray page background and
 *               muddled with info-blue, so the warning family is orange;
 *  - important: subtle red, most noticeable;
 *  - success:   subtle green.
 *
 * An empty or failed fetch renders nothing — the storefront layout is
 * untouched when there are no active announcements.
 */

const TYPE_STYLES: Record<
  AnnouncementType,
  {
    Icon: (props: { className?: string }) => React.ReactElement;
    strip: string;
    chip: string;
  }
> = {
  info: {
    Icon: InfoIcon,
    strip: 'border-blue-200 border-l-2 border-l-blue-400 bg-blue-50/60',
    chip: 'bg-blue-100 text-blue-600',
  },
  warning: {
    Icon: WarningIcon,
    strip: 'border-orange-300 border-l-2 border-l-orange-500 bg-orange-50/70',
    chip: 'bg-orange-100 text-orange-600',
  },
  important: {
    Icon: ImportantIcon,
    strip: 'border-red-200 border-l-2 border-l-red-600 bg-red-50/70',
    chip: 'bg-red-100 text-red-600',
  },
  success: {
    Icon: SuccessIcon,
    strip: 'border-emerald-200 border-l-2 border-l-emerald-500 bg-emerald-50/60',
    chip: 'bg-emerald-100 text-emerald-600',
  },
};

export default async function Announcements() {
  const announcements = await fetchActiveAnnouncements();
  if (announcements.length === 0) return null;

  return (
    <div className="px-3 py-2.5 sm:py-3">
      <div
        className="space-y-2"
        role="region"
        aria-label="Повідомлення магазину"
      >
        {announcements.map((announcement) => {
          const style = TYPE_STYLES[announcement.type] ?? TYPE_STYLES.info;
          const { Icon } = style;
          return (
            <div
              key={announcement.id}
              className={`mx-auto flex w-full max-w-[720px] items-start gap-2.5 rounded-lg border px-3 py-2.5 sm:w-fit sm:items-center sm:gap-3 sm:px-4 sm:py-2.5 ${style.strip}`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full sm:h-7 sm:w-7 ${style.chip}`}
                aria-hidden="true"
              >
                <Icon className="h-4 w-4 sm:h-[18px] sm:w-[18px]" />
              </span>
              <p className="min-w-0 leading-snug">
                <span className="text-sm font-semibold text-gray-900">
                  {announcement.title}
                </span>
                <span
                  aria-hidden="true"
                  className="hidden select-none px-1.5 text-gray-300 sm:inline"
                >
                  ·
                </span>
                <span className="mt-0.5 block break-words text-[13px] text-gray-600 sm:mt-0 sm:inline">
                  {announcement.message}
                </span>
              </p>
              <span className="sr-only">
                {ANNOUNCEMENT_TYPE_META[announcement.type].label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
