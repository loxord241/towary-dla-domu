import type { Metadata } from 'next';
import InfoPage from '@/app/components/InfoPage';

export const metadata: Metadata = {
  title: 'Про нас — Товари для дому',
  description: 'Інформація про інтернет-магазин Товари для дому',
  // Audit R11 2026-09-15: self canonical + full OG card — a page-level og
  // REPLACES the layout default (shallow metadata merge), so the messenger
  // preview must repeat locale/type/siteName/image explicitly instead of
  // showing the generic shop card.
  alternates: { canonical: '/about' },
  openGraph: {
    title: 'Про нас — Товари для дому',
    description: 'Інформація про інтернет-магазин Товари для дому',
    locale: 'uk_UA',
    type: 'website',
    siteName: 'Товари для дому',
    images: ['/og-image.png'],
  },
};

export default function Page() {
  return (
    <InfoPage title="Про нас">
      <p>
        {`Раді вітати вас у інтернет магазині Товари для дому— місці, де народжується затишок вашого дому! З 2011 року ми з любов'ю підбираємо надійну побутову техніку, яка щодня дарує вам комфорт і турботу. Наші клієнти отримують чесні ціни завдяки прямим поставкам, офіційну гарантію від виробника. Замовляйте з блискавичною доставкою по Україні або заглядайте в гості у Кривому Розі — ми завжди вам раді!`}
      </p>
    </InfoPage>
  );
}
