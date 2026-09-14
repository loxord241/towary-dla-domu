/**
 * Epicentr-style PDP text generation (spec
 * docs/superpowers/specs/2026-09-14-epicentr-description-pattern.md, Phase 1).
 *
 * Pure decision/assembly core: NO React, NO next imports, NO I/O —
 * loadable under node:test. The rendering side lives in
 * app/components/ProductIntro.tsx (server component).
 *
 * TRUTHFULNESS INVARIANT (spec §5/§8.4): every generated sentence is built
 * ONLY from `specifications`, `brand` and `name`. Feed VALUES are inserted
 * verbatim (units are never altered, numbers are never reformatted); the
 * only rewrites are
 *   - «Так/Ні/Немає» values voiced through a small curated phrase table
 *     (spec rule 4: never copy «Так/Ні» into prose), and
 *   - a trailing unit that the FEED stores in the KEY («Діаметр, см» + «24»
 *     → «діаметр 24 см») moved after the value it belongs to.
 * A fact with no safe phrasing is dropped, never paraphrased by invention.
 * When too few facts can be voiced the generator returns ''/null and the
 * caller skips the block entirely.
 */

import {
  sanitizeSpecRows,
  type ProductSpecificationsRow,
} from './product-specifications.ts';

// ---------------------------------------------------------------------------
// Category → priority dictionary (spec §5)
// ---------------------------------------------------------------------------

export type SpecCategoryKind = 'wallpaper' | 'cookware' | 'appliance' | 'generic';

/** Пріоритетні ключі specifications: посуд (spec §5). */
const COOKWARE_PRIORITY = [
  'Тип',
  'Матеріал',
  'Діаметр',
  'Антипригарне покриття',
  'Тип джерела тепла',
] as const;

/** Пріоритетні ключі specifications: техніка (spec §5). */
const APPLIANCE_PRIORITY = [
  'Тип',
  'Потужність',
  "Об'єм",
  'Матеріал корпусу',
  'Оснащення',
] as const;

/** Пріоритетні ключі specifications: шпалери (spec §5). */
const WALLPAPER_PRIORITY = [
  'Тип',
  'Основа',
  'Розмір рулону',
  'Мийність',
  'Країна',
] as const;

/**
 * Category classification. Feed category slugs carry unstable numeric
 * suffixes («skovoridky-ta-soteinyky-1367»), so groups are matched by
 * lowercase substrings observed in the live categories table (2026-09-14).
 * APPLIANCE markers are checked BEFORE cookware: «elektrochainyky» contains
 * «chainyky» and «posudomyini mashyny» contains «posud» — both are
 * appliance groups. Unmatched slugs → 'generic' → empty priority →
 * buildKeySpecs falls back to the first N feed rows (spec §8.3).
 */
const APPLIANCE_SLUG_MARKERS = [
  'tekhnika',
  'elektrochainyky',
  'kholodylnyk',
  'morozyl',
  'pralni-mashyny',
  'posudomyin',
  'svch-',
  'dukhovi-shafy',
  'multyvarky',
  'parovarky',
  'blendery',
  'miksery',
  'kombainy',
  'kavovarky',
  'kavomolky',
  'tostery',
  'buterbrodnytsi',
  'frytiurnytsi',
  'pylosmoky',
  'kondytsionery',
  'obihrivach',
  'teploventyliatory',
  'ventyliatory',
  'vodonahrivachi',
  'vytiazhky',
  'nastilni-plyty',
  'plyty-',
  'elektropechi',
  'multypechi',
  'khlibopichky',
  'hryl',
  'vahy',
  'shveini',
  'lomterizky',
  'miasorubky',
  'elektrosusharky',
  'tertky-elektrychni',
  'sushylni-mashyny',
  'paroochyshchuvach',
  'ochyshchuvach',
  'zvolozhuvach',
  'osushuvach',
  'klimatychni',
  'elektrychni-',
  'hazovi-',
  'induktsiini-',
  'sklokeramichni-',
  'kombinovani-',
  'susharky-dlia-rushnykiv',
  'freshnytsi',
];

const COOKWARE_SLUG_MARKERS = [
  'posud',
  'skovorid',
  'kastrul',
  'chainyky',
  'hlechyk',
  'husiatnyts',
  'tarelk',
  'tarilk',
  'chashk',
  'chark',
  'sklian',
  'kelykh',
  'kryshk',
  'sousnyk',
  'spetsivnyk',
  'tsukornyts',
  'masliank',
  'molochnyk',
  'tortivnyts',
  'pytne-sklo',
  'pytni-nabory',
  'stolovi',
  'formy-dlia-vypikannia',
  'doska-dlia-narizannia',
  'nozhi',
  'nozhiv',
  'french-pres',
  'nabory-dlia-napoiv',
  'mlynnyts',
  'kukhonne-pryladdia',
  'kukhonni-aksesuary',
  'multistalery',
  'vidertsia',
  'tatsi-',
  'pliashky',
  'dyspensery',
  'popilnychky',
];

/** Domain of a category slug (tests and callers may branch on the kind). */
export function specCategoryKind(categorySlug: string | null | undefined): SpecCategoryKind {
  const slug = (categorySlug ?? '').toLowerCase();
  if (!slug) return 'generic';
  // Wallpapers: the importer's shpaleri-* subtree (glue categories are
  // «klei…»/«kleyi…» slugs and never start with the prefix).
  if (slug.startsWith('shpaleri')) return 'wallpaper';
  if (APPLIANCE_SLUG_MARKERS.some((m) => slug.includes(m))) return 'appliance';
  if (COOKWARE_SLUG_MARKERS.some((m) => slug.includes(m))) return 'cookware';
  return 'generic';
}

/**
 * Пріоритетні ключі specifications для категорії (spec §5). Unknown/generic
 * categories → [] → buildKeySpecs falls back to the first N feed rows.
 */
export function categorySpecPriority(categorySlug: string | null): readonly string[] {
  switch (specCategoryKind(categorySlug)) {
    case 'wallpaper':
      return WALLPAPER_PRIORITY;
    case 'cookware':
      return COOKWARE_PRIORITY;
    case 'appliance':
      return APPLIANCE_PRIORITY;
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Key matching (feed keys are NOT normalized between suppliers, spec §8.3)
// ---------------------------------------------------------------------------

/** Fold case, whitespace and the three apostrophe variants («Об'єм/Об’єм»). */
function normKey(s: string): string {
  return s
    .replace(/['’ʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Index of the row matching `key`: exact normalized equality wins over
 * substring («Тип» must not be swallowed by «Тип джерела тепла»), already
 * used rows never match twice. -1 when nothing matches.
 */
function findRow(rows: ProductSpecificationsRow[], used: Set<number>, key: string): number {
  const nk = normKey(key);
  for (let i = 0; i < rows.length; i++) {
    if (!used.has(i) && normKey(rows[i]!.name) === nk) return i;
  }
  for (let i = 0; i < rows.length; i++) {
    if (!used.has(i) && normKey(rows[i]!.name).includes(nk)) return i;
  }
  return -1;
}

/**
 * Топ-ключі «Основних характеристик»: rows matched by the category
 * priority dictionary (in dictionary order), then padded with the
 * remaining feed rows in feed order. Without a dictionary (generic
 * category) this is exactly the first `limit` feed rows — the spec §8.3
 * fallback. Values come from sanitizeSpecRows (same display form as the
 * full table).
 */
export function buildKeySpecs(
  specifications: unknown,
  categorySlug: string | null,
  limit = 5
): ProductSpecificationsRow[] {
  const rows = sanitizeSpecRows(specifications);
  const max = Math.max(0, limit);
  if (rows.length === 0 || max === 0) return [];

  const result: ProductSpecificationsRow[] = [];
  const used = new Set<number>();
  for (const key of categorySpecPriority(categorySlug)) {
    if (result.length >= max) break;
    const idx = findRow(rows, used, key);
    if (idx >= 0) {
      used.add(idx);
      result.push(rows[idx]!);
    }
  }
  for (let i = 0; i < rows.length && result.length < max; i++) {
    if (!used.has(i)) {
      used.add(i);
      result.push(rows[i]!);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fact phrasing (spec §5 rules)
// ---------------------------------------------------------------------------

const TRUE_VALUES = new Set(['так', 'є']);
const FALSE_VALUES = new Set(['ні', 'немає', 'нема', 'відсутній', 'відсутня', 'відсутнє']);

/**
 * Boolean rewording table (spec §5 rule 4). First matching key substring
 * wins; a boolean value with no entry here is DROPPED from generated text
 * (it still renders in the tables).
 */
const BOOLEAN_PHRASES: ReadonlyArray<{
  match: (key: string) => boolean;
  yes: string;
  no: string;
}> = [
  {
    match: (k) => k.includes('антипригар'),
    yes: 'з антипригарним покриттям',
    no: 'без антипригарного покриття',
  },
  {
    match: (k) => k.startsWith('можна') || k.includes('посудомийн'),
    yes: 'можна мити в посудомийній машині',
    no: 'не можна мити в посудомийній машині',
  },
  {
    match: (k) => k.includes('мийн') || k.includes('мійн'),
    yes: 'миються',
    no: 'не миються',
  },
];

/** A feed value that is pure measurement tokens («24», «1850 - 2200», «21.7 х 23.7 х 16»). */
function isNumericish(value: string): boolean {
  return /^[\d.,\sxх×/+-]+$/.test(value);
}

/** Short unit token the feed may store at the end of a value («0.53 м»). */
function trailingUnit(value: string): boolean {
  return /\s[а-щьюяіїєґa-z]{1,4}\.?$/i.test(value);
}

export interface FactClause {
  /** Embedded form («діаметр 24 см», «матеріал: Скло»). */
  short: string;
  /** Standalone-sentence form («Діаметр 24 см», «Матеріал — Скло»). */
  sentence: string;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * One specification row → voiceable fact, or null when the row must not
 * enter generated prose: «Тип» (the name already states it), boolean
 * values without a curated phrase, absence values, or values already
 * carried by the product name («Серія: Be Hard» on «…Be Hard…»).
 */
function factClause(name: string, value: string, productName: string): FactClause | null {
  const key = normKey(name);
  const val = normKey(value);

  // «Тип: Сковороди» — тип і так названо в H1; у тексті це шум.
  if (key === 'тип') return null;

  if (TRUE_VALUES.has(val) || FALSE_VALUES.has(val)) {
    const positive = TRUE_VALUES.has(val);
    const phrase = BOOLEAN_PHRASES.find((p) => p.match(key));
    if (!phrase) return null;
    const text = positive ? phrase.yes : phrase.no;
    return { short: text, sentence: capitalize(text) };
  }

  // Value already visible in the product name (alphabetic values only —
  // digits like «24» appear in names far too often to dedupe on).
  if (
    val.length >= 4 &&
    /\p{L}/u.test(val) &&
    normKey(productName).includes(val)
  ) {
    return null;
  }

  // Units: «Діаметр, см» + «24» → «діаметр 24 см» (the unit follows the
  // value it belongs to; never reformatted, only relocated). Keys without
  // a comma-unit keep «ключ: значення» with the value verbatim.
  let label = name.trim();
  let unit = '';
  const commaIdx = label.lastIndexOf(',');
  if (commaIdx >= 0) {
    const tail = label.slice(commaIdx + 1).trim();
    if (/^[а-щьюяіїєґa-z]{1,4}\.?$/i.test(tail)) {
      unit = tail.replace(/\.$/, '');
      label = label.slice(0, commaIdx).trim();
    }
  }
  const lowerLabel = label.charAt(0).toLowerCase() + label.slice(1);
  if (unit) {
    const short = `${lowerLabel} ${value} ${unit}`;
    return { short, sentence: capitalize(short) };
  }
  if (isNumericish(value) || trailingUnit(value)) {
    const short = `${lowerLabel} ${value}`;
    return { short, sentence: capitalize(short) };
  }
  return {
    short: `${lowerLabel}: ${value}`,
    sentence: `${capitalize(label)} — ${value}`,
  };
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Lead paragraph
// ---------------------------------------------------------------------------

export interface LeadInput {
  name: string;
  brand?: string | null;
  specifications?: unknown;
  categorySlug?: string | null;
}

export const LEAD_MIN_SPECS = 3;

/**
 * Лид-абзац за зразком Epicentr (spec §5): 2–4 речення, ≤60 слів, лише
 * факти з specifications/brand/name. Факти беруться з ТОП-ключів
 * (buildKeySpecs), тому лид узгоджений з блоком «Основні характеристики».
 * Повертає '' коли висловити можна менше ніж 2 факти — тоді лід не
 * пишеться взагалі (spec §5: «нет данных — предложение не пишется»).
 */
export function buildLeadParagraph(input: LeadInput): string {
  const name = input.name.trim();
  if (name === '') return '';

  const keyRows = buildKeySpecs(input.specifications, input.categorySlug ?? null, 5);
  const clauses: FactClause[] = [];
  for (const row of keyRows) {
    const clause = factClause(row.name, row.value, name);
    if (clause) clauses.push(clause);
  }
  // 1 речення = ім'я + 1 факт; менше 2 фактів → лід не пишемо.
  if (clauses.length < 2) return '';

  const brand = (input.brand ?? '').trim();
  const brandInName =
    brand !== '' && normKey(name).includes(normKey(brand));
  const nameBase =
    brand !== '' && !brandInName ? `${name} (${brand})` : name;

  const sentences: string[] = [
    `${nameBase} — ${clauses[0]!.short}.`,
  ];
  let words = countWords(sentences[0]!);
  for (const clause of clauses.slice(1)) {
    if (sentences.length >= 4) break;
    const sentence = `${clause.sentence}.`;
    if (words + countWords(sentence) > 60) break;
    sentences.push(sentence);
    words += countWords(sentence);
  }
  return sentences.join(' ');
}

// ---------------------------------------------------------------------------
// Generated description (products WITHOUT a real supplier description)
// ---------------------------------------------------------------------------

export interface GeneratedDescription {
  /** 'list' — маркирований список фич (техніка, формат Epicentr §2.2); 'paragraph' — абзац (посуда/інше). */
  format: 'list' | 'paragraph';
  /** Рядки списку або речення абзацу (без крапки в кінці рядків списку). */
  lines: string[];
}

const GENERATED_MAX_LINES = 10;
const GENERATED_MAX_WORDS = 80;

/**
 * Текст «Опис» для товарів БЕЗ реального опису (spec §5): маркирований
 * список фич для техніки (формат Epicentr §2.2 — чайник Edenberg ~10
 * пунктів), фактичний абзац для посуди/інших категорій. Лише факти з
 * specifications, у порядку фіду; null коли висловлюваних фактів менше 2.
 * Реальний supplier-description має пріоритет — ця функція викликається
 * тільки коли shouldRenderDescriptionSection === false.
 */
export function buildGeneratedDescription(input: {
  name?: string | null;
  specifications?: unknown;
  categorySlug?: string | null;
}): GeneratedDescription | null {
  const productName = input.name ?? '';
  const rows = sanitizeSpecRows(input.specifications);
  const clauses: FactClause[] = [];
  for (const row of rows) {
    const clause = factClause(row.name, row.value, productName);
    if (clause) clauses.push(clause);
  }
  if (clauses.length < 2) return null;

  const format: GeneratedDescription['format'] =
    specCategoryKind(input.categorySlug) === 'appliance' ? 'list' : 'paragraph';

  const lines: string[] = [];
  let words = 0;
  for (const clause of clauses) {
    if (lines.length >= GENERATED_MAX_LINES) break;
    const line = format === 'list' ? clause.sentence : `${clause.sentence}.`;
    const lineWords = countWords(line);
    if (lines.length > 0 && words + lineWords > GENERATED_MAX_WORDS) break;
    lines.push(line);
    words += lineWords;
  }
  return { format, lines };
}
