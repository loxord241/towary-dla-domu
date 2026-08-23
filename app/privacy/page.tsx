import InfoPage from '@/app/components/InfoPage';

export default function Page() {
  return (
    <InfoPage
      title="Політика конфіденційності"
      requiredContent={[
        "Юридичний текст політики (які дані збираємо, мета, строк зберігання)",
        "Відповідність законодавству України про персональні дані",
        "Підтвердження юриста перед публікацією",
      ]}
    />
  );
}
