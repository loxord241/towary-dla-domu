import Link from 'next/link';
import { StarIcon } from './icons';
import ReviewFormModal from './ReviewFormModal';
import type { ReviewSummary, ReviewsPageData } from '@/app/lib/catalog';

const dateFormatter = new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'long',
});

function Stars({ value }: { value: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      aria-label={`Оцінка ${value} з 5`}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <StarIcon
          key={star}
          className={`h-4 w-4 ${
            star <= Math.round(value) ? 'text-amber-500' : 'text-gray-300'
          }`}
          filled={star <= Math.round(value)}
        />
      ))}
    </span>
  );
}

function pluralReviews(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'відгук';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'відгуки';
  return 'відгуків';
}

/**
 * «Відгуки» section of the product page. Pure server component: all data is
 * fetched by the page (RLS-published rows only) and passed down as props.
 * Review text renders as React text children — no HTML sink anywhere in
 * this feature; the only name ever shown is the user-typed display name.
 */
export default function ProductReviews({
  productId,
  summary,
  data,
  productSlug,
}: {
  productId: string;
  summary: ReviewSummary;
  data: ReviewsPageData;
  productSlug: string;
}) {
  const totalPages = Math.max(1, Math.ceil(data.total / (data.pageSize || 1)));
  const basePath = `/product/${encodeURIComponent(productSlug)}`;
  const pageHref = (page: number) => `${basePath}?reviews_page=${page}`;

  return (
    <section
      id="reviews"
      className="mb-8 scroll-mt-24 rounded-lg bg-white p-6 shadow"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">Відгуки</h2>
        <ReviewFormModal label="Залишити відгук" productId={productId} />
      </div>

      {summary.total === 0 ? (
        <p className="text-gray-500">
          Ще немає відгуків — станьте першим, хто залишить відгук про цей товар.
        </p>
      ) : (
        <>
          {/* Average + star distribution */}
          <div className="mb-6 flex flex-col gap-6 sm:flex-row sm:items-start md:gap-10">
            <div className="text-center sm:w-40">
              <p className="text-4xl font-extrabold text-gray-900">
                {summary.average !== null ? summary.average.toFixed(1) : '—'}
              </p>
              <div className="mt-1 flex justify-center">
                <Stars value={summary.average ?? 0} />
              </div>
              <p className="mt-1 text-sm text-gray-500">
                {summary.total} {pluralReviews(summary.total)}
              </p>
            </div>
            <div className="flex-1 space-y-1.5">
              {[5, 4, 3, 2, 1].map((stars) => {
                const count = summary.distribution[stars - 1];
                const percent =
                  summary.total > 0
                    ? Math.round((count / summary.total) * 100)
                    : 0;
                return (
                  <div key={stars} className="flex items-center gap-2 text-sm">
                    <span className="w-8 shrink-0 text-right text-gray-600">
                      {stars} ★
                    </span>
                    <div
                      className="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-100"
                      role="presentation"
                    >
                      <div
                        className="h-full rounded-full bg-amber-400"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-gray-500">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <ul className="space-y-4">
            {data.reviews.map((review) => (
              <li key={review.id} className="rounded-xl border border-gray-200 p-4">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <Stars value={review.rating} />
                  <time dateTime={review.created_at} className="text-xs text-gray-400">
                    {dateFormatter.format(new Date(review.created_at))}
                  </time>
                </div>
                <p className="text-sm font-semibold text-gray-900">
                  {review.display_name ?? 'Анонімний відгук'}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                  {review.text}
                </p>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <nav
              aria-label="Пагінація відгуків"
              className="mt-5 flex items-center justify-between text-sm"
            >
              {data.page > 1 ? (
                <Link href={pageHref(data.page - 1)} className="text-blue-600 hover:underline">
                  ← Попередні
                </Link>
              ) : (
                <span />
              )}
              <span className="text-gray-500">
                Сторінка {data.page} з {totalPages}
              </span>
              {data.page < totalPages ? (
                <Link href={pageHref(data.page + 1)} className="text-blue-600 hover:underline">
                  Наступні →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </section>
  );
}
