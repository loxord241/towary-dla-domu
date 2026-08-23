import InfoPage from '@/app/components/InfoPage';

export default function Page() {
  return (
    <InfoPage
      title="Умови використання"
      requiredContent={[
        "Юридичні умови використання сайту та покупок",
        "Порядок оформлення та скасування замовлень",
        "Підтвердження юриста перед публікацією",
      ]}
    />
  );
}
