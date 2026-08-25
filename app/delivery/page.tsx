import type { Metadata } from 'next';
import InfoPage from '@/app/components/InfoPage';

export const metadata: Metadata = {
  title: 'Доставка та оплата — E-Shop',
  description: 'Умови доставки та оплати замовлень інтернет-магазину E-Shop',
};

export default function Page() {
  return (
    <InfoPage title="Доставка та оплата">
      <div className="space-y-4 text-base leading-relaxed text-gray-700">
        <section>
          <h2 className="text-xl font-semibold tracking-tight text-gray-900">
            Доставка по Україні
          </h2>
          <p>Ми доставляємо товари по Україні через:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{`Нову Пошту;`}</li>
            <li>{`Укрпошту;`}</li>
            <li>{`Делівері;`}</li>
            <li>{`кур’єрську доставку по місту Кривий Ріг.`}</li>
          </ul>
          <p>
            {`Також доступний самовивіз із магазину «Товари для дому» у Кривому Розі.`}
          </p>
          <p>
            {`Ми розуміємо, наскільки важливо отримати техніку швидко та без пошкоджень, тому приділяємо особливу увагу пакуванню, перевірці товару та консультації клієнта перед відправкою.`}
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold tracking-tight text-gray-900">
            Оплата, кредитування та оплата частинами
          </h2>
          <p>{`У Магазині «Товари для дому»доступні зручні способи оплати:`}</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{`післяплата по передоплаті 20% на розрахунковий рахунок IBAN`}</li>
            <li>{`онлайн-оплата;`}</li>
            <li>{`оплата карткою;`}</li>
            <li>{`банківський переказ;`}</li>
            <li>{`оплата частинами.`}</li>
          </ul>
          <p>Ми працюємо з популярними банківськими сервісами:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{`ПриватБанк «Оплата частинами»;`}</li>
            <li>{`ПУМБ «Купуй частинами»;`}</li>
            <li>{`А-Банк «Покупка частинами».`}</li>
          </ul>
        </section>
      </div>
    </InfoPage>
  );
}
