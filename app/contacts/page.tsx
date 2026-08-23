import InfoPage from '@/app/components/InfoPage';

export default function Page() {
  return (
    <InfoPage
      title="Контакти"
      intro="Контактні дані магазину"
      requiredContent={[
        "Реальна email-адреса підтримки",
        "Телефон(и) та години роботи",
        "Адреса/соцмережі за наявності",
      ]}
    />
  );
}
