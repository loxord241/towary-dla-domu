import type { Metadata } from 'next';
import InfoPage from '@/app/components/InfoPage';

export const metadata: Metadata = {
  title: 'Контакти — Товари для дому',
  description: 'Контактні дані інтернет-магазину Товари для дому',
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
          {`Адреса магазину: м. Кривий Ріг, вул.Гетьмана Івана Мазепи,буд. 87А`}
        </p>
        <p>
          {`Телефон: `}
          {/* Displayed number stays verbatim; tel: makes it one-tap callable. */}
          <a
            href="tel:+380973144221"
            className="font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2"
          >
            {`+38 (097)314 42 21`}
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
