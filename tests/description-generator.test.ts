/**
 * Unit coverage for app/lib/description-generator.ts (Epicentr-style PDP
 * intro, spec docs/superpowers/specs/2026-09-14-epicentr-description-pattern.md,
 * Phase 1). Fixtures are REAL product rows fetched from the live database
 * (2026-09-14): cookware YC-7135808, appliance YC-7023707 (spec §6),
 * wallpaper wc-x39169 — same shapes as products.specifications JSONB.
 *
 * TRUTHFULNESS pins: feed values verbatim (units included), «Так/Ні/Немає»
 * never copied into prose, facts already present in the name are not
 * repeated, and <2 voiceable facts → no text at all.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  categorySpecPriority,
  specCategoryKind,
  buildKeySpecs,
  buildLeadParagraph,
  buildGeneratedDescription,
  LEAD_MIN_SPECS,
} = await import('../app/lib/description-generator.ts');

// ---- real DB fixtures (2026-09-14) -------------------------------------------

/** YC-7135808 «Сковорода IQ Be Hard глибока 24 см б/кришки (IQ-1155-24)». */
const SKOVORODKA_NAME = 'Сковорода IQ Be Hard глибока 24 см б/кришки (IQ-1155-24)';
const SKOVORODKA_SPECS = [
  { name: 'Серія', value: 'Be Hard' },
  { name: 'Тип', value: 'Сковороди' },
  { name: 'Діаметр, см', value: '24' },
  { name: 'Висота стінки, см', value: '5.5' },
  { name: 'Призначення', value: 'Класична' },
  { name: 'Матеріал', value: 'Литий алюміній' },
  { name: 'Матеріал кришки', value: 'Немає' },
  { name: 'Матеріал ручок', value: 'Бакеліт з покриттям Soft-touch' },
  { name: 'Антипригарне покриття', value: 'Так' },
  {
    name: 'Тип джерела тепла',
    value: 'Газова плита, Електрична плита, Галогенна / Склокерамічна плита, Індукційна плита',
  },
  { name: 'Можна мити в посудомийній машині', value: 'Ні' },
  { name: 'Знімна ручка', value: 'Ні' },
];
const SKOVORODKA_SLUG = 'skovoridky-ta-soteinyky-1367';

/** YC-7023707 «Чайник GORENJE K17GXG» — description = NULL (заглушка сегодня). */
const KETTLE_NAME = 'Чайник GORENJE K17GXG';
// «Об'єм» у фіді несе U+2019 — словник має збігатися незалежно від апострофа.
const KETTLE_SPECS = [
  { name: 'Тип', value: 'Звичайний' },
  { name: 'Об\u2019єм, л', value: '1.70' },
  { name: 'Потужність, Вт', value: '1850 - 2200' },
  { name: 'Нагрівальний елемент', value: 'Диск (прихований)' },
  { name: 'Матеріал корпусу', value: 'Скло' },
  {
    name: 'Оснащення',
    value:
      'Фільтр від накипу, Індикатор рівня води, Обертання на 360°, Світлова індикація роботи, Відсік для зберігання шнура, Автоматичне відключення',
  },
  { name: 'Захист', value: 'Від перегріву' },
  { name: 'Довжина кабелю, м', value: '0.65' },
  { name: 'Розміри, см', value: '21.7 х 23.7 х 16' },
  { name: 'Вага, кг', value: '1.1' },
];
const KETTLE_SLUG = 'elektrochainyky-1409';

/** wc-x39169 «Класіка 5208-04,рулон 10м» — фід шпалер має лише 4 ключі. */
const WALLPAPER_NAME = 'Класіка 5208-04,рулон 10м';
const WALLPAPER_SPECS = [
  { name: 'Довжина', value: '10.05 м' },
  { name: 'Ширина', value: '0.53 м' },
  { name: 'Основа', value: 'Паперова' },
  { name: 'Приміщення', value: 'Дитяча, Вітальня, Спальня' },
];
const WALLPAPER_SLUG = 'shpaleri-duplex';

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function sentences(s: string): number {
  // Кінець речення = крапка перед пробілом або в кінці рядка;
  // десяткові крапки («1.7») кінцями речень не рахуються.
  return (s.match(/\.\s|\.$/g) ?? []).length;
}

// ---- categorySpecPriority -----------------------------------------------------

test('priority: категорії-групи зі словником spec §5', () => {
  assert.deepEqual(categorySpecPriority(SKOVORODKA_SLUG), [
    'Тип',
    'Матеріал',
    'Діаметр',
    'Антипригарне покриття',
    'Тип джерела тепла',
  ]);
  assert.deepEqual(categorySpecPriority(KETTLE_SLUG), [
    'Тип',
    'Потужність',
    "Об'єм",
    'Матеріал корпусу',
    'Оснащення',
  ]);
  assert.deepEqual(categorySpecPriority('shpaleri-vinyl-15m'), [
    'Тип',
    'Основа',
    'Розмір рулону',
    'Мийність',
    'Країна',
  ]);
  // корінь піддерева шпалер без суфікса теж шпалери
  assert.equal(specCategoryKind('shpaleri'), 'wallpaper');
});

test('priority: клей для шпалер — НЕ шпалери; невідомі/null → [] (фолбэк перших N рядків)', () => {
  assert.notEqual(specCategoryKind('kleyi-dlya-shpaler'), 'wallpaper');
  assert.notEqual(specCategoryKind('Klei-na-shpalery'), 'wallpaper');
  assert.deepEqual(categorySpecPriority('kleyi-dlya-shpaler'), []);
  assert.deepEqual(categorySpecPriority('inshe-1418'), []);
  assert.deepEqual(categorySpecPriority(null), []);
  assert.deepEqual(categorySpecPriority(''), []);
});

test('priority: техніка перемагає посуд при перетині маркерів (elektrochainyky, posudomyini)', () => {
  assert.equal(specCategoryKind('elektrochainyky-1409'), 'appliance');
  assert.equal(specCategoryKind('posudomyini-mashyny-205'), 'appliance');
  assert.equal(specCategoryKind('chainyky-zavarochni-1390'), 'cookware');
  assert.equal(specCategoryKind('kukhonnyi-posud-155'), 'cookware');
  assert.equal(specCategoryKind('pobutova-tekhnika-1186'), 'appliance');
});

// ---- buildKeySpecs ------------------------------------------------------------

test('keySpecs: сковорода — топ-5 у порядку словника посуду, ключі фіду без нормалізації', () => {
  const keys = buildKeySpecs(SKOVORODKA_SPECS, SKOVORODKA_SLUG).map((r) => r.name);
  assert.deepEqual(keys, [
    'Тип',
    'Матеріал',
    'Діаметр, см',
    'Антипригарне покриття',
    'Тип джерела тепла',
  ]);
});

test('keySpecs: чайник — «Об’єм, л» матчиться через апостроф/підстроку, значення санітизуються', () => {
  const rows = buildKeySpecs(KETTLE_SPECS, KETTLE_SLUG);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Тип', 'Потужність, Вт', 'Об\u2019єм, л', 'Матеріал корпусу', 'Оснащення']
  );
  // sanitizeSpecRows-форма, як у повній таблиці: «1.70» → «1.7»
  assert.deepEqual(rows.find((r) => r.name.startsWith('Об'))?.value, '1.7');
  assert.deepEqual(rows.find((r) => r.name.startsWith('Потужність'))?.value, '1850 - 2200');
});

test('keySpecs: exact-матч перемагає підстроку («Матеріал», а не «Матеріал кришки»)', () => {
  const rows = buildKeySpecs(SKOVORODKA_SPECS, SKOVORODKA_SLUG);
  assert.deepEqual(rows.find((r) => r.name === 'Матеріал')?.value, 'Литий алюміній');
  assert.ok(!rows.some((r) => r.name === 'Матеріал кришки'));
});

test('keySpecs: шпалери — лише «Основа» зі словника, решта добирається порядком фіду', () => {
  const rows = buildKeySpecs(WALLPAPER_SPECS, WALLPAPER_SLUG);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Основа', 'Довжина', 'Ширина', 'Приміщення']
  );
});

test('keySpecs: фолбэк — без словника це перші N рядків фіду; limit працює', () => {
  const fallback = buildKeySpecs(SKOVORODKA_SPECS, null);
  assert.deepEqual(
    fallback.map((r) => r.name),
    SKOVORODKA_SPECS.slice(0, 5).map((r) => r.name)
  );
  assert.deepEqual(
    buildKeySpecs(SKOVORODKA_SPECS, null, 3).map((r) => r.name),
    ['Серія', 'Тип', 'Діаметр, см']
  );
  // dict-категорія з меншим limit
  assert.equal(buildKeySpecs(SKOVORODKA_SPECS, SKOVORODKA_SLUG, 2).length, 2);
  assert.deepEqual(buildKeySpecs(null, SKOVORODKA_SLUG), []);
  assert.deepEqual(buildKeySpecs([], SKOVORODKA_SLUG), []);
});

// ---- buildLeadParagraph ---------------------------------------------------------

test('lead: чайник YC-7023707 — 4 речення ≤60 слів, факти з фіду, без «Так/Ні»', () => {
  const lead = buildLeadParagraph({
    name: KETTLE_NAME,
    brand: 'GORENJE',
    specifications: KETTLE_SPECS,
    categorySlug: KETTLE_SLUG,
  });
  assert.ok(lead.startsWith(`${KETTLE_NAME} — потужність 1850 - 2200 Вт.`), lead);
  assert.match(lead, /Об.єм 1\.7 л\./, 'одиниця «л» перенесена з ключа фіду до значення');
  assert.match(lead, /Матеріал корпусу — Скло\./);
  assert.match(lead, /Оснащення — Фільтр від накипу/);
  // бренд уже в назві — не дублюється
  assert.equal(lead.split('GORENJE').length - 1, 1);
  assert.ok(sentences(lead) >= 2 && sentences(lead) <= 4, lead);
  assert.ok(words(lead) <= 60, `≤60 слів, маємо ${words(lead)}`);
  assert.ok(!/\b(Так|Ні|Немає)\b/.test(lead), '«Так/Ні» не копіюються в текст');
});

test('lead: сковорода YC-7135808 — «Так» озвучено словами, «Ні» посудомийки НЕ потрапляє (не в топ-5)', () => {
  const lead = buildLeadParagraph({
    name: SKOVORODKA_NAME,
    brand: 'IQ',
    specifications: SKOVORODKA_SPECS,
    categorySlug: SKOVORODKA_SLUG,
  });
  assert.ok(lead.startsWith(`${SKOVORODKA_NAME} — матеріал: Литий алюміній.`), lead);
  assert.match(lead, /Діаметр 24 см\./);
  assert.match(lead, /З антипригарним покриттям\./, '«Так» → словами');
  assert.match(lead, /Тип джерела тепла — Газова плита/);
  assert.ok(!/\bТак\b/.test(lead));
  assert.ok(!/\bНі\b/.test(lead));
  assert.ok(!lead.includes('Немає'));
  assert.ok(sentences(lead) >= 2 && sentences(lead) <= 4);
  assert.ok(words(lead) <= 60);
});

test('lead: одиниці з фіду не змінюються («1850 - 2200», «21.7 х 23.7 х 16», десяткова крапка)', () => {
  const lead = buildLeadParagraph({
    name: KETTLE_NAME,
    brand: 'GORENJE',
    specifications: KETTLE_SPECS,
    categorySlug: KETTLE_SLUG,
  });
  assert.ok(lead.includes('1850 - 2200 Вт'), 'значення фіду дослівно');
});

test('lead: шпалери — факти з 4-ключового фіду, бренд відсутній без дужок', () => {
  const lead = buildLeadParagraph({
    name: WALLPAPER_NAME,
    brand: null,
    specifications: WALLPAPER_SPECS,
    categorySlug: WALLPAPER_SLUG,
  });
  assert.ok(lead.startsWith(`${WALLPAPER_NAME} — основа: Паперова.`), lead);
  assert.match(lead, /Довжина 10\.05 м\./);
  assert.match(lead, /Ширина 0\.53 м\./);
  assert.match(lead, /Приміщення — Дитяча, Вітальня, Спальня\./);
  assert.ok(!lead.includes('('), 'без бренду немає і дужок');
  assert.ok(words(lead) <= 60);
});

test('lead: бренд поза назвою додається в дужках; «Серія» з назви не повторюється', () => {
  const lead = buildLeadParagraph({
    name: SKOVORODKA_NAME,
    brand: 'IQ',
    specifications: SKOVORODKA_SPECS,
    categorySlug: SKOVORODKA_SLUG,
  });
  // «IQ» уже в назві → жодного «(IQ)»
  assert.ok(!lead.includes('(IQ)'));
  // «Be Hard» уже в назві → «Серія» не озвучується
  assert.ok(!lead.includes('Серія'));
});

test('lead: бренд, якого немає в назві, зʼявляється в дужках', () => {
  const lead = buildLeadParagraph({
    name: 'Рамка для фото 10х15',
    brand: 'Weekend',
    specifications: [
      { name: 'Діаметр, см', value: '24' },
      { name: 'Матеріал', value: 'Скло' },
    ],
    categorySlug: null,
  });
  assert.ok(lead.startsWith('Рамка для фото 10х15 (Weekend) — діаметр 24 см.'), lead);
});

test('lead: менше 2 висловлюваних фактів — лід не пишеться (порожній рядок)', () => {
  assert.equal(
    buildLeadParagraph({
      name: 'Товар',
      specifications: [{ name: 'Тип', value: 'Звичайний' }],
      categorySlug: KETTLE_SLUG,
    }),
    ''
  );
  assert.equal(
    buildLeadParagraph({ name: 'Товар', specifications: null, categorySlug: null }),
    ''
  );
  assert.equal(
    buildLeadParagraph({ name: '', specifications: KETTLE_SPECS, categorySlug: KETTLE_SLUG }),
    ''
  );
  // лише один озвучуваний факт після фільтрів («Тип» — шум, «Матеріал» — 1)
  assert.equal(
    buildLeadParagraph({
      name: 'Товар',
      specifications: [
        { name: 'Тип', value: 'Звичайний' },
        { name: 'Матеріал', value: 'Скло' },
      ],
      categorySlug: null,
    }),
    ''
  );
  assert.equal(LEAD_MIN_SPECS, 3);
});

test('lead: ліміт 60 слів зупиняє додавання речень, а не обрізає текст', () => {
  const longValue = Array.from({ length: 60 }, (_, i) => `слово${i}`).join(' ');
  const lead = buildLeadParagraph({
    name: 'Товар',
    specifications: [
      { name: 'Матеріал', value: 'Скло' },
      { name: 'Діаметр, см', value: '24' },
      { name: 'Оснащення', value: longValue },
    ],
    categorySlug: null,
  });
  assert.ok(!lead.includes('слово59'), 'надлиций факт не потрапив у текст');
  assert.ok(words(lead) <= 60, `≤60 слів, маємо ${words(lead)}`);
  assert.ok(!lead.endsWith('слово'), 'текст не обрізаний посередині');
});

// ---- buildGeneratedDescription -------------------------------------------------

test('generated: чайник (техніка) — список фич, 9 рядків, формат Epicentr §2.2', () => {
  const gen = buildGeneratedDescription({
    name: KETTLE_NAME,
    specifications: KETTLE_SPECS,
    categorySlug: KETTLE_SLUG,
  });
  assert.ok(gen);
  assert.equal(gen.format, 'list');
  assert.deepEqual(gen.lines, [
    'Об\u2019єм 1.7 л',
    'Потужність 1850 - 2200 Вт',
    'Нагрівальний елемент — Диск (прихований)',
    'Матеріал корпусу — Скло',
    'Оснащення — Фільтр від накипу, Індикатор рівня води, Обертання на 360°, Світлова індикація роботи, Відсік для зберігання шнура, Автоматичне відключення',
    'Захист — Від перегріву',
    'Довжина кабелю 0.65 м',
    'Розміри 21.7 х 23.7 х 16 см',
    'Вага 1.1 кг',
  ]);
  // «Тип: Звичайний» — шум, у список не потрапляє
  assert.ok(!gen.lines.some((l) => l.includes('Звичайний')));
});

test('generated: посуд — абзац, «Ні» посудомийки озвучено, «Немає» кришки пропущено', () => {
  const gen = buildGeneratedDescription({
    name: SKOVORODKA_NAME,
    specifications: SKOVORODKA_SPECS,
    categorySlug: SKOVORODKA_SLUG,
  });
  assert.ok(gen);
  assert.equal(gen.format, 'paragraph');
  const text = gen.lines.join(' ');
  assert.match(text, /[Нн]е можна мити в посудомийній машині\./, '«Ні» → словами');
  assert.ok(!text.includes('Матеріал кришки'), '«Немає» без фрази-шаблона → факт пропущено');
  assert.ok(!/\bНі\b/.test(text));
  assert.ok(words(text) <= 80);
  // «Серія: Be Hard» уже в назві
  assert.ok(!text.includes('Серія'));
});

test('generated: шпалери — абзац з основою та розмірами', () => {
  const gen = buildGeneratedDescription({
    name: WALLPAPER_NAME,
    specifications: WALLPAPER_SPECS,
    categorySlug: WALLPAPER_SLUG,
  });
  assert.ok(gen);
  assert.equal(gen.format, 'paragraph');
  const text = gen.lines.join(' ');
  assert.match(text, /Основа — Паперова\./);
  assert.match(text, /Довжина 10\.05 м\./);
  assert.match(text, /Ширина 0\.53 м\./);
});

test('generated: <2 фактів або порожні specifications → null', () => {
  assert.equal(
    buildGeneratedDescription({
      specifications: [{ name: 'Тип', value: 'Звичайний' }],
      categorySlug: KETTLE_SLUG,
    }),
    null
  );
  assert.equal(buildGeneratedDescription({ specifications: null }), null);
  assert.equal(buildGeneratedDescription({ specifications: 'junk' }), null);
});
