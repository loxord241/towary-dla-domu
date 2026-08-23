import InfoPage from '@/app/components/InfoPage';

export default function Page() {
  return (
    <InfoPage
      title="Повернення"
      intro="Умови повернення та обміну"
      requiredContent={[
        "Строки повернення — підтвердити у юриста (законодавство України)",
        "Порядок оформлення повернення",
        "Контакт для запитів на повернення",
      ]}
    />
  );
}
