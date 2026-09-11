/**
 * FAQ content for wallpaper category pages (2026-09-11, owner-approved
 * «FAQ-блоки» stage). PURE and runtime-dependency-free so node:test loads
 * it without Supabase.
 *
 * Honesty rules (same discipline as schema-org.ts): every answer states a
 * fact verifiable against PROJECT_CONTEXT — Nova Post/Ukrposhta delivery,
 * 100% online LiqPay payment, the roll calculator on the product card.
 * Shop policies we do NOT have codified (returns/exchanges, pickup) are
 * deliberately answered with «за домовленістю з менеджером» /
 * «уточнюйте у менеджера» instead of invented rules.
 */

export interface FaqItem {
  question: string;
  answer: string;
}

/** FAQ list rendered by FaqSection and serialized by FaqJsonLd. */
export const WALLPAPER_FAQ: FaqItem[] = [
  {
    question: 'Як розрахувати, скільки потрібно рулонів шпалер?',
    answer:
      'Кількість рулонів рахують від периметра кімнати та висоти стін, із запасом на підгонку малюнка. На картці кожного товару є калькулятор, який зробить розрахунок за вашими розмірами.',
  },
  {
    question: 'Як здійснюється доставка?',
    answer:
      'Відправляємо по всій Україні перевізниками Нова Пошта та Укрпошта. Деталі відправлення узгоджуються при оформленні замовлення.',
  },
  {
    question: 'Як оплатити замовлення?',
    answer:
      'Оплата — 100% онлайн через платіжний сервіс LiqPay банківською карткою. Після успішної оплати замовлення передається менеджеру на обробку.',
  },
  {
    question: 'Чи можна повернути або обміняти шпалери?',
    answer:
      'Умови повернення та обміну шпалер визначаються за домовленістю з менеджером. Зверніться до нас — розглянемо вашу ситуацію.',
  },
  {
    question: 'Чи можуть фото відрізнятися від реального відтінку шпалер?',
    answer:
      'Так, відтінок на екрані може трохи відрізнятися від оригінала через налаштування дисплея та освітлення при зйомці. Якщо колір для вас критичний, уточніть відтінок у менеджера перед замовленням.',
  },
  {
    question: 'Чи є самовивіз?',
    answer: 'Можливість самовивізу уточнюйте у менеджера.',
  },
];

/**
 * Wallpaper categories are the «Шпалери» subtree: the root slug and all
 * its subgroup slugs share the 'shpaleri' prefix (see
 * app/lib/wallpapers/categories.ts). Undefined/no category → false.
 */
export function isWallpaperCategorySlug(slug: string | undefined): boolean {
  return typeof slug === 'string' && slug.startsWith('shpaleri');
}
