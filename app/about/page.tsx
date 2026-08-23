import InfoPage from '@/app/components/InfoPage';

export default function Page() {
  return (
    <InfoPage
      title="О нас"
      intro="Інформація про магазин"
      requiredContent={[
        "Історія та опис магазину",
        "Місія та цінності",
        "Фотографії та реквізити компанії",
      ]}
    />
  );
}
