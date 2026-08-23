import InfoPage from '@/app/components/InfoPage';

export default function Page() {
  return (
    <InfoPage
      title="Доставка і оплата"
      intro="Умови доставки та оплати"
      requiredContent={[
        "Перелік служб доставки та зон покриття",
        "Вартість і терміни доставки",
        "Способи оплати (під час підключення)",
      ]}
    />
  );
}
