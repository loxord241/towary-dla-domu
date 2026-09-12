import type { Metadata } from 'next';
import InfoPage from '@/app/components/InfoPage';

export const metadata: Metadata = {
  title: 'Доставка та оплата — Товари для дому',
  description: 'Умови доставки та оплати замовлень інтернет-магазину Товари для дому',
};

export default function Page() {
  return (
    <InfoPage title="Доставка та оплата">
      <div className="space-y-4 text-base leading-relaxed text-gray-700">
        <section>
          <h2 className="text-xl font-semibold tracking-tight text-gray-900">
            Доставка по Україні
          </h2>
          <p>Ми доставляємо товари по Україні перевізниками:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{`«Нова Пошта» — відділення, поштомат або кур’єрська доставка;`}</li>
            <li>{`«Укрпошта» — відділення.`}</li>
          </ul>
          <p>
            {`Спосіб доставки обирається під час оформлення замовлення. Вартість
            доставки розраховується за тарифами перевізника та залежить від
            ваги, розмірів і регіону відправлення.`}
          </p>
          <p>
            {`Ми розуміємо, наскільки важливо отримати техніку швидко та без пошкоджень, тому приділяємо особливу увагу пакуванню, перевірці товару та консультації клієнта перед відправкою.`}
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold tracking-tight text-gray-900">
            Оплата
          </h2>
          <p>
            {`Оплата замовлення — 100% онлайн через платіжний сервіс LiqPay
            одразу після оформлення замовлення.`}
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold tracking-tight text-gray-900">
            Оплата частинами
          </h2>
          <p>
            {`Оформити покупку в оплату частинами — «Оплата частинами»
            ПриватБанку, «Купуй частинами» ПУМБ або «Покупка частинами»
            А-Банку — можна за телефонами:`}
          </p>
          <p>
            <a
              href="tel:+380973144221"
              className="whitespace-nowrap font-medium text-blue-600 hover:underline"
            >
              +380 (97) 314 42 21
            </a>
            {`, `}
            <a
              href="tel:+380983584958"
              className="whitespace-nowrap font-medium text-blue-600 hover:underline"
            >
              +380 (98) 358 49 58
            </a>
          </p>
        </section>
      </div>
    </InfoPage>
  );
}
