import type { Metadata } from 'next';
import InfoPage from '@/app/components/InfoPage';

export const metadata: Metadata = {
  title: 'Контакти — Товари для дому',
  description: 'Контактні дані інтернет-магазину Товари для дому',
  // Audit R11 2026-09-15: self canonical + full OG card — a page-level og
  // REPLACES the layout default (shallow metadata merge), so the messenger
  // preview must repeat locale/type/siteName/image explicitly instead of
  // showing the generic shop card.
  alternates: { canonical: '/contacts' },
  openGraph: {
    title: 'Контакти — Товари для дому',
    description: 'Контактні дані інтернет-магазину Товари для дому',
    locale: 'uk_UA',
    type: 'website',
    siteName: 'Товари для дому',
    images: ['/og-image.png'],
  },
};

export default function Page() {
  return (
    <InfoPage title="Контакти">
      <div className="space-y-4 text-base leading-relaxed text-gray-700">
        <h2 className="text-xl font-semibold tracking-tight text-gray-900">
          Контактна інформація
        </h2>
        <p>
          {`Магазин Товари для дому ФОП  Денисенко Світлана Юріївна ІПН: 3161712967`}
        </p>
        <p>
          {`Пункти видачі (самовивіз — безкоштовно):`}
        </p>
        <ul className="list-disc list-inside space-y-2">
          <li>
            <span>{`вул. Гетьмана Івана Мазепи, буд. 87А — побутова техніка;`}</span>
            {' · '}
            <a
              href={`https://www.google.com/maps/search/?api=1&query=Кривий+Ріг+${encodeURIComponent('вул. Гетьмана Івана Мазепи, 87А')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2 text-sm"
            >
              Відкрити на карті
            </a>
          </li>
          <li>
            <span>{`вул. Гетьмана Івана Мазепи, буд. 83А — шпалери;`}</span>
            {' · '}
            <a
              href={`https://www.google.com/maps/search/?api=1&query=Кривий+Ріг+${encodeURIComponent('вул. Гетьмана Івана Мазепи, 83А')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2 text-sm"
            >
              Відкрити на карті
            </a>
          </li>
          <li>
            <span>{`вул. Гетьмана Івана Мазепи, буд. 89А — лінолеум.`}</span>
            {' · '}
            <a
              href={`https://www.google.com/maps/search/?api=1&query=Кривий+Ріг+${encodeURIComponent('вул. Гетьмана Івана Мазепи, 89А')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2 text-sm"
            >
              Відкрити на карті
            </a>
          </li>
        </ul>
        <p>{`Час роботи: 7:30–16:00`}</p>
        <p>
          {`Телефони: `}
          {/* Displayed numbers match the header format; tel: makes each
              one-tap callable. */}
          <a
            href="tel:+380973144221"
            className="font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2"
          >
            {`+380 (97) 314 42 21`}
          </a>
          {`, `}
          <a
            href="tel:+380983584958"
            className="font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2"
          >
            {`+380 (98) 358 49 58`}
          </a>
        </p>
        <p>
          {`E-mail: `}
          <a
            href="mailto:magazinujut@gmail.com"
            className="font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2"
          >
            {`magazinujut@gmail.com`}
          </a>
        </p>
      </div>
    </InfoPage>
  );
}
