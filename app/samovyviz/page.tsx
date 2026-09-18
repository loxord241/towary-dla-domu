import type { Metadata } from 'next';
import Image from 'next/image';
import SiteHeader from '@/app/components/SiteHeader';
import SiteFooter from '@/app/components/SiteFooter';

/**
 * «Самовивіз» (власник, 2026-09-14): індексована сторінка точок видачі у
 * Кривому Розі з фотографіями. Адреси/спеціалізація збігаються з
 * PICKUP_POINTS (app/lib/checkout-delivery.ts) — єдиним білим списком
 * чекаута; телефони й графік — з публічної сторінки /contacts.
 * Третя точка — Мазепи 89А (лінолеум, рішення власника 2026-09-17): поки
 * текстова картка БЕЗ фото (очікуються), з контактним телефоном магазину.
 */
export const metadata: Metadata = {
  title: 'Самовивіз у Кривому Розі — Товари для дому',
  description:
    'Безкоштовний самовивіз у Кривому Розі: побутова техніка й товари для дому — вул. Гетьмана Івана Мазепи, 87А, шпалери — вул. Гетьмана Івана Мазепи, 83А, лінолеум — вул. Гетьмана Івана Мазепи, 89А. Адреси, телефони та фото пунктів видачі.',
  alternates: { canonical: '/samovyviz' },
};

// Графік публічний на /contacts («Час роботи: 7:30–16:00», без днів);
// одна змінна — щоб правка була в один рядок, коли власник уточнить
// графік саме для точок.
const HOURS = 'Час роботи: 7:30–16:00';
const CALLS_NOTE = 'Приймаємо дзвінки та передзвонюємо до 16:00';

interface PickupPointCard {
  /** h2 картки — адреса точки, canonical form з PICKUP_POINTS. */
  address: string;
  specialization: string;
  /** Публічний телефон ТОЧКИ (з /contacts). */
  phoneHref?: string;
  phoneLabel?: string;
  photos: { src: string; alt: string }[];
}

const MAZEPY_PHOTOS = Array.from({ length: 7 }, (_, i) => ({
  src: `/pickup/mazepy-${i + 1}.jpg`,
  alt: `Пункт видачі на вул. Гетьмана Івана Мазепи, 87А — фото ${i + 1}`,
}));

const MAZEPY_83A_PHOTOS = Array.from({ length: 9 }, (_, i) => ({
  src: `/pickup/mazepy-83a-${i + 1}.jpg`,
  alt: `Пункт видачі «Затишок — світ шпалер» на вул. Гетьмана Івана Мазепи, 83А — фото ${i + 1}`,
}));

const POINTS: PickupPointCard[] = [
  {
    address: 'вул. Гетьмана Івана Мазепи, 87А',
    specialization: 'Побутова техніка і товари для дому',
    phoneHref: 'tel:+380973144221',
    phoneLabel: '+380 (97) 314 42 21',
    photos: MAZEPY_PHOTOS,
  },
  {
    address: 'вул. Гетьмана Івана Мазепи, 83А',
    specialization: 'Шпалери',
    phoneHref: 'tel:+380983584958',
    phoneLabel: '+380 (98) 358 49 58',
    photos: MAZEPY_83A_PHOTOS,
  },
  {
    address: 'вул. Гетьмана Івана Мазепи, 89А',
    specialization: 'Лінолеум',
    phoneHref: 'tel:+380973144221',
    phoneLabel: '+380 (97) 314 42 21',
    // Фото 89А ще не надійшли (очікуються) — картка поки текстова; фото
    // додам окремою правкою, коли власник передасть файли.
    photos: [],
  },
];

export default function SamovyvizPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />
      <main className="container mx-auto px-4 py-10">
        <div className="mx-auto max-w-4xl">
          <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 mb-2">
            Самовивіз у Кривому Розі
          </h1>
          <div aria-hidden className="mb-6 h-1 w-12 rounded bg-blue-600" />
          <p className="mb-8 text-base leading-relaxed text-gray-600">
            Забрати замовлення можна безкоштовно в одній із трьох точок видачі.
            Пункт обирається під час оформлення замовлення: техніка і товари
            для дому чекають на Мазепи 87А, шпалери — на Гетьмана Івана Мазепи
            83А, лінолеум — на Гетьмана Івана Мазепи 89А. Якщо в кошику товари
            кількох напрямків — усе замовлення чекатиме на обраній точці.
          </p>

          <div className="space-y-10">
            {POINTS.map((point, pointIndex) => (
              <section
                key={point.address}
                className="rounded-lg border border-gray-200 bg-white p-5 sm:p-6"
              >
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-semibold tracking-tight text-gray-900">
                      {point.address}
                    </h2>
                    <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                      Безкоштовно
                    </span>
                  </div>
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=Кривий+Ріг+${encodeURIComponent(point.address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-[44px] items-center text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2"
                  >
                    Відкрити на карті →
                  </a>
                </div>
                <p className="mb-1 text-sm text-gray-500">{point.specialization}</p>
                <p className="mb-1 text-sm text-gray-700">
                  Графік: {HOURS}
                </p>
                {/* Телефон і «дзвінки до 16:00» — для точок із
                    публічним номером (номер для 89А додано з /contacts). */}
                {point.phoneHref && point.phoneLabel && (
                  <>
                    <p className="mb-3 text-sm text-gray-700">{CALLS_NOTE}</p>
                    <a
                      href={point.phoneHref}
                      className="inline-flex min-h-[44px] items-center font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2"
                    >
                      {point.phoneLabel}
                    </a>
                  </>
                )}
                {point.photos.length > 0 && (
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {point.photos.map((photo, photoIndex) => (
                      <Image
                        key={photo.src}
                        src={photo.src}
                        alt={photo.alt}
                        width={960}
                        height={1280}
                        // Only the very first photo of the page may compete for
                        // LCP; everything else loads lazily (next/image default).
                        priority={pointIndex === 0 && photoIndex === 0}
                        sizes="(max-width: 640px) 50vw, 300px"
                        className="h-auto w-full rounded-lg"
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
