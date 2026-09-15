import type { Metadata } from 'next';
// Task #41 2026-09-02: the plain-text strip + placeholder check moved to
// app/lib/product-description.ts (client-safe module, no boilerplate lists);
// re-exported here so the meta policy keeps its public API.
import {
  htmlToPlainText,
  isPlaceholderDescription,
} from './product-description.ts';

export { htmlToPlainText, isPlaceholderDescription };

/**
 * Canonical/noindex policy for the storefront (spec 2026-08-26 + Task #14
 * 2026-09): the indexable set is EXACTLY the sitemap set — bare /catalog
 * plus single valid, NON-EMPTY category/brand views on page 1 with the
 * default sort and no extra filters. «Non-empty» means ≥1 eligible product
 * (active + ≥1 photo; category counts follow the junction + subtree
 * semantics of fetchCatalogProducts). Everything else (search results,
 * filter combinations, pagination depth, empty views, unknown slugs) is
 * noindex,follow WITHOUT a canonical tag: Google ignores canonicals on
 * noindexed pages, and emitting one would send contradictory signals.
 * Unknown category/brand slugs stay a normal 200 empty state — they are
 * filter VALUES on an existing resource (/catalog), not missing resources
 * (approved decision A of the spec).
 */

export const SITE_NAME = 'Товари для дому';

/** Default sort value of /catalog — anything else is a duplicate-content view. */
const DEFAULT_SORT = 'newest';

export interface CatalogIndexInput {
  search?: string;
  categorySlug?: string;
  brandSlug?: string;
  /** slug resolved to an ACTIVE entity (fetchCategoryBySlug/fetchBrandBySlug) */
  categoryFound?: boolean;
  brandFound?: boolean;
  /**
   * Eligible-product fact for the requested view (Task #14): false marks an
   * EMPTY view (0 eligible products) → noindex. Undefined = fact unknown →
   * treated as non-empty so callers that cannot measure it keep legacy
   * behavior. Never read for the non-requested entity.
   */
  categoryHasProducts?: boolean;
  brandHasProducts?: boolean;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sort?: string;
  page?: number;
}

export interface IndexingDecision {
  indexable: boolean;
  /** Absolute-path canonical for THIS url; null → omit the tag entirely. */
  canonicalPath: string | null;
}

export function decideCatalogIndexing(
  input: CatalogIndexInput
): IndexingDecision {
  const hasSearch = Boolean(input.search);
  const categoryRequested = Boolean(input.categorySlug);
  const brandRequested = Boolean(input.brandSlug);
  const categoryValid =
    categoryRequested && input.categorySlug !== undefined && input.categoryFound === true;
  const brandValid =
    brandRequested && input.brandSlug !== undefined && input.brandFound === true;

  const invalidSlug =
    (categoryRequested && !categoryValid) || (brandRequested && !brandValid);
  const emptyView =
    (categoryValid && input.categoryHasProducts === false) ||
    (brandValid && input.brandHasProducts === false);
  const multiFilter =
    (categoryRequested && brandRequested) ||
    input.minPrice !== undefined ||
    input.maxPrice !== undefined ||
    input.inStockOnly === true ||
    (input.sort ?? DEFAULT_SORT) !== DEFAULT_SORT ||
    (input.page ?? 1) > 1;

  if (hasSearch || invalidSlug || emptyView || multiFilter) {
    return { indexable: false, canonicalPath: null };
  }

  if (categoryValid) {
    return {
      indexable: true,
      // 2026-09-13 (owner task): category views moved to human-readable
      // path URLs — /catalog/<slug> is THE canonical form. The legacy
      // /catalog?category=<slug> query form 308-redirects to the path
      // shape (proxy.ts), so both routes emit the path-form canonical.
      canonicalPath: `/catalog/${encodeURIComponent(input.categorySlug!)}`,
    };
  }
  if (brandValid) {
    return {
      indexable: true,
      canonicalPath: `/catalog?brand=${encodeURIComponent(input.brandSlug!)}`,
    };
  }
  return { indexable: true, canonicalPath: '/catalog' };
}

/**
 * Normalize a raw user query for display in <title>/description:
 * strip control characters (they have no place in SERP snippets), collapse
 * whitespace, hard-cap length. PostgREST specials were already handled by
 * sanitizeSearchTerm for QUERIES; this is purely presentation-side.
 */
export function truncateQuery(raw: string, max = 50): string {
  const cleaned = raw
    // Non-whitespace control bytes are garbage → removed; \t\n\r fall
    // through and are treated as ordinary whitespace separators below.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[%,()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, max);
}

export interface CatalogViewMetadataArgs {
  input: CatalogIndexInput;
  categoryName?: string;
  brandName?: string;
  /**
   * Admin-authored description of the requested category
   * (categories.description, PLAIN text — see category-description.ts).
   * When non-blank, the category branch uses its first ≤160 chars
   * (word-boundary cut, truncateMetaDescription) as the meta description
   * instead of the generic template; every other view keeps the template.
   * Callers pass it from the React-cache()d fetchCategoryDescription — the
   * SAME call the page body makes, so the metadata pass adds no extra DB
   * read in the same render.
   */
  categoryDescription?: string | null;
  /**
   * Admin-authored description of the requested brand (brands.description —
   * audit R8 2026-09-15). Same contract as categoryDescription: non-blank
   * copy wins, blank/null falls back to the brand template. Fed from the
   * React-cache()d fetchBrandDescription (lib/brand-description.ts).
   */
  brandDescription?: string | null;
}

type ViewMetadata = Pick<
  Metadata,
  'title' | 'description' | 'robots' | 'alternates' | 'openGraph'
>;

/**
 * Page-level openGraph REPLACES the root layout's whole openGraph object
 * (shallow metadata merge — generate-metadata docs), so catalog/oboi views
 * must repeat locale/type/siteName AND the default image: without them a
 * category link shared in Viber/Telegram would lose og:image entirely
 * (audit 2026-09-13 — the repost showed the bare layout default because the
 * views set no og fields at all). `url` is intentionally omitted — the
 * canonical URL lives in `alternates` (the decision above stays the single
 * source). Image = the same committed static /og-image.png the root layout
 * and homepage pin (tests/og-metadata.test.ts).
 */
function buildViewOpenGraph(
  title: string,
  description: string
): NonNullable<ViewMetadata['openGraph']> {
  return {
    title,
    description,
    locale: 'uk_UA',
    type: 'website',
    siteName: SITE_NAME,
    images: ['/og-image.png'],
  };
}

/**
 * Meta-description cap for the admin category copy: first ≤max chars cut on
 * a WORD boundary (a word chopped mid-way reads broken in SERP/messenger
 * snippets). Whitespace runs collapse first (admin prose is plain text that
 * may carry newlines); a single word longer than the cap falls back to a
 * hard slice so the cap is always honored.
 */
export function truncateMetaDescription(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const window = flat.slice(0, max + 1);
  const cut = window.lastIndexOf(' ');
  return (cut > 0 ? window.slice(0, cut) : flat.slice(0, max)).trim();
}

/**
 * Geo tail for the TEMPLATE descriptions (marketing audit 2026-09-14:
 * generic metas carried no geo). Added to description templates only —
 * titles stay geo-free (a city tail would push them past the ~60-char
 * SERP window). Search views keep the bare query echo: they are noindex
 * duplicates, geo there adds nothing. Admin category copy, when present,
 * wins unchanged (truncateMetaDescription) — the templates are the
 * fallback path.
 */
const GEO_TAIL = 'з доставкою по Україні та самовивозом у Кривому Розі';

export function buildCatalogViewMetadata(
  args: CatalogViewMetadataArgs
): ViewMetadata {
  const { input, categoryName, brandName, categoryDescription, brandDescription } = args;
  const decision = decideCatalogIndexing(input);

  let title = `Каталог товарів | ${SITE_NAME}`;
  let description =
    'Каталог товарів інтернет-магазину Товари для дому з фільтрами та сортуванням — доставка по Україні та самовивіз у Кривому Розі.';

  if (input.search) {
    const q = truncateQuery(input.search);
    title = `Пошук: «${q}» | ${SITE_NAME}`;
    description = `Результати пошуку за запитом «${q}» в інтернет-магазині ${SITE_NAME}.`;
  } else if (input.categorySlug && categoryName) {
    // Audit R4 2026-09-15: the previous tail «— купити в Товари для дому»
    // read ungrammatically (no noun after «в») and spent the ~60-char SERP
    // window on a phrase the description template already carries. The
    // brand-only tail follows the proven pinned-category pattern
    // (category-seo.ts, «Дрібна побутова техніка — Товари для дому»); the
    // commercial «купити» intent stays in the description. NOTE: /oboi
    // deliberately KEEPS its own «Шпалери — купити в …» title so the two
    // «Шпалери» surfaces (/oboi vs /catalog/shpaleri) stop sharing one
    // SERP string (audit R5 2026-09-15).
    title = `${categoryName} — ${SITE_NAME}`;
    // Unique admin copy first (audit 2026-09-13 — the template was shared by
    // every category while the pages carry unique intro texts); the generic
    // template stays the fallback for categories without a description.
    const adminCopy = categoryDescription
      ? truncateMetaDescription(categoryDescription)
      : '';
    description =
      adminCopy ||
      `Товари у категорії «${categoryName}» — купити в інтернет-магазині ${SITE_NAME} ${GEO_TAIL}.`;
  } else if (input.brandSlug && brandName) {
    title = `${brandName} — ${SITE_NAME}`;
    // Audit R8 2026-09-15: brand admin copy (brands.description) wins like
    // the category copy above; the template stays the fallback.
    const brandCopy = brandDescription
      ? truncateMetaDescription(brandDescription)
      : '';
    description =
      brandCopy ||
      `Товари бренду ${brandName} — купити в інтернет-магазині ${SITE_NAME} ${GEO_TAIL}.`;
  }

  return {
    title,
    description,
    // og on noindex views (search/filtered) is harmless and keeps messenger
    // previews meaningful; the canonical decision above is untouched.
    openGraph: buildViewOpenGraph(title, description),
    ...(decision.indexable ? {} : { robots: { index: false, follow: true } }),
    ...(decision.canonicalPath
      ? { alternates: { canonical: decision.canonicalPath } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// /oboi — wallpapers storefront (owner task 2026-09-10). A STATIC indexable
// route on the same footing as /catalog: it is part of the
// «indexable set = sitemap set» invariant, and app/sitemap.ts lists it in
// its static entries. Deep pagination (?page=N>1) AND spec-filtered views
// (?base=…, owner task 2026-09-11 — any value present, junk included: these
// are filter VALUES on an existing resource, not routes) follow the catalog
// policy: a noindex,follow duplicate view WITHOUT a canonical tag
// (canonicals on noindex pages send contradictory signals).
// ---------------------------------------------------------------------------

export const OBOI_CANONICAL_PATH = '/oboi';

export function buildWallpapersMetadata(
  page = 1,
  /** Raw ?base= param: ANY present value (even '' or junk) → noindex. */
  base?: string,
  /** Raw ?sort= param: ANY present value → noindex. The DEFAULT sort on
      /oboi is alphabetical (owner 2026-09-12) — «/oboi» without params IS
      the sorted view, so only explicit reorderings are duplicates. */
  sort?: string
): ViewMetadata {
  const title = `Шпалери — купити в ${SITE_NAME}`;
  // Copy stays factual: the type list mirrors the wallpaper subcategory
  // names the importer creates (app/lib/wallpapers/categories.ts);
  // «метрові» removed 2026-09-12 together with the category. Geo tail in
  // the description only (audit 2026-09-14) — the title stays geo-free.
  const description = `Каталог шпалер інтернет-магазину ${SITE_NAME}: вініл, флізелін, дуплекс, шовкографія та інші типи — ${GEO_TAIL}.`;

  if (page > 1 || base !== undefined || (sort !== undefined && sort !== '')) {
    return {
      title,
      description,
      openGraph: buildViewOpenGraph(title, description),
      robots: { index: false, follow: true },
    };
  }

  return {
    title,
    description,
    openGraph: buildViewOpenGraph(title, description),
    alternates: { canonical: OBOI_CANONICAL_PATH },
  };
}

// ---------------------------------------------------------------------------
// PDP meta-description policy (audit 2026-08-31)
//
// Two classes of supplier descriptions must NOT leak into meta descriptions:
//   1) placeholder HTML — tags/whitespace/nbsp only (133 live products);
//   2) brand boilerplate templates shared verbatim across hundreds of
//      products (Tramontina/Luminarc/Pyrex families) — the first 160 chars
//      produced massive duplicated metas.
// Policy: short_description → unique description (capped) → generic
// name-based fallback. Nothing is ever invented: the fallback is the same
// name-based template the page already used. Visible page content,
// Product JSON-LD, sitemap and canonicals are intentionally NOT affected.
// ---------------------------------------------------------------------------

/** True when the description carries no text at all (tags/nbsp/whitespace). */
// isPlaceholderDescription — see app/lib/product-description.ts (re-exported above).

/**
 * Supplier boilerplate markers (audit 2026-08-31 + Task #23 V2 audit
 * 2026-09-01, verified on live data). Matched case-insensitively on the
 * PLAIN text; extend only with a marker verified against real duplicated
 * descriptions (0 false positives, brand-pure on the active catalog).
 */
const BOILERPLATE_MARKERS: readonly string[] = [
  // Task #14 audit 2026-08-31 (original three families)
  'кожен виріб', // Tramontina family (×377)
  'бренд високоякісного посуду', // Luminarc family (×229, with/without ®)
  'винайдений у франції', // Pyrex family (×91)
  // Task #23 V2 audit 2026-09-01 (verified: 0 FP, brand-pure)
  'склюзивно для юг-контракт',
  'склюзивно для компанії',
  'посуд для приготування під торговою маркою iq',
  'торгова марка ringel',
  'ringel - бренд якісного',
  'кухонні аксесуари ringel',
  'bravo chef – це посуд',
  'компанія kastamonu',
  'ipec - найбільший виробник',
  'бренд tramontina заснований',
  'фоторамка la — елегантне',
  'guten morgen',
  'серія longchamp',
  'kora від limited edition',
  'шторка для ванної idea home',
  'вішалка для одягу з гачками',
  'бренд arcoroc',
  'chef&sommelier',
  'франція і кухня мають особливий',
  'у металевих серіях тм pyrex',
  'сковорідки та каструлі pyrex',
  'серія ножів athus',
  'команда фахівців тм eleyus',
  'наша компактна пральна машина',
  'скатертина водовідштовхувальна',
  'особливості сковорід oscar chef',
  'каструля з литого алюмінію серії zitrone',
  'чому «tesy»?',
  'ножі серії master - ідеальні ножі',
  'металеві вази для зберігання фруктів',
  'стильна прикраса на вашому столі',
  'чашки з подвійними стінками',
  'склянки з подвійними стінками',
  'посуд і предмети для сервірування від бренду led',
  'колекція преміум-класу rowenta',
  'чавунні решітки progrids',
  'у руках майстрів своєї справи',
];

/**
 * V3 supplier boilerplate TEMPLATES (Task #25 audit 2026-09-01, verified on
 * live data): verbatim template heads shared across whole appliance families
 * (Samsung/Hisense/Dreame/Philips/Gorenje/Tefal/Electrolux/Sencor/...).
 * Unlike the V1/V2 markers above these are matched as PREFIXES — startsWith
 * against the first 160 plain-text chars (exactly the meta cap): a unique
 * factual head with the template later in the text must stay unique (the 5
 * contains-matches of the audit were verified false positives and are
 * excluded by prefix semantics). All entries are lowercase, ≤160 chars
 * (meta cap) and were confirmed 0-FP / brand-pure before shipping; extend
 * only with a marker verified against real duplicated descriptions.
 */
const BOILERPLATE_PREFIXES: readonly string[] = [
  "інтелектуальний робот-пилосос для ідеальної чистоти робот-пилосос dreame x60 ultra complete - це сучасний девайс, створений для ефективного та повністю автомати",
  "робот-пилосос dreame aqua 10 roller — прибирання як мистецтво за чистою підлогою та вашим спокоєм стоїть dreame aqua 10 ultra roller. робот-пилосос рухається ак",
  "інтелектуальне прання енергоефективність. клас енергоефективності a економте енергію, але періть одяг так само якісно. відповідно до нового європейського енерге",
  "суперпрання з технологією ші автоматично підбирає ідеальний цикл прання для вашої білизни, зважуючи та визначаючи завантаження. більше жодних вгадувань! функція",
  "fresh crisper. зона зберігання fresh crisper зона fresh crisper у холодильниках бренду hisense забезпечує достатньо місця для фруктів та овочів, а її оптимальна",
  "кондиціонери серії smart ніяких компромісів спліт-системи серії smart оснащені сучасними та технологічними dc-інверторними компресорами, які забезпечать комфорт",
  "серія be brave від iq - це посуд, виготовлений з високоякісного кованого алюмінію з антипригарним покриттям xylan від whitford . таке покриття забезпечує інтенс",
  "серія be trendy від iq - це посуд, виготовлений з високоякісного литого алюмінію з антипригарним покриттям xylan від whitford . таке покриття забезпечує інтенси",
  "ефективне видалення нальоту та біліші зуби біліші зуби – це реально завдяки центральній ділянці для видалення плям на цій насадці для відбілювання w. ромбоподіб",
  "робот-пилосос миючий mova s70 roller: покращені сценарії автономного прибирання чистота вдома зазвичай тримається на вашому вільному часі. ви або прибираєте сам",
  "швидке приготування заморожених продуктів ця ефективна програма ідеально підходить для приготування будь-яких заморожених продуктів і напівфабрикатів. корисні з",
  "поліурентанова піна переваги поліуретанової піни ефективність унікальної технології adaptair і алюмінієвих жирових фільтрів збільшується за рахунок особливої ​​",
  "мотор inverterpowerdrive винятково надійний і ефективний інверторний мотор потужний інверторний мотор працює без щіток, тому відсутні механічні дії, тертя та зн",
  "до 20 разів краще усунення нальоту порівняно зі звичайною зубною щіткою* кожен чистить зуби по-різному, тому ми розробили насадку all-in-one, яка має точнонахил",
  "компанія solmazer (туреччина), що почала свою діяльність як невелике сімейне підприємство з виготовлення виробів зі скла, ось уже кілька десятиліть є виробником",
  "сковорода tefal start'easy 28 см c2690621 — універсальна сковорода збільшеного розміру для щоденного приготування страв. завдяки довговічному титановому антипри",
  "вологе чищення очищення мікрохвильової печі без зайвих зусиль наповніть водою чашку з кераміки або скла, придатного для використання в мікрохвильовій печі. пост",
  "сковорода tefal start'easy 24 см c2690421 — універсальна сковорода для щоденного приготування, яка поєднує довговічне антипригарне покриття, швидке та рівномірн",
  "простір для свіжості та продуманий комфорт холодильник dreame megapro поєднує місткість, сучасні технології та стильний дизайн для щоденного комфорту. завдяки в",
  "до 10 разів краще усунення нальоту у порівнянні зі звичайною зубною щіткою глибоке очищення вимагає особливого підходу, і м'яка насадка покращує рух щетинок, що",
  "до 10 разів краще усунення нальоту порівняно зі звичайною зубною щіткою глибоке очищення вимагає особливого підходу, і м'яка насадка покращує рух щетинок, щоб к",
  "лагідне, але ефективне чищення чутливих зубів і ясен дбайливе очищення для чутливих зубів і ясен. ретельне очищення може бути ніжним. ця насадка має унікальний ",
  "усунення до 100% більше пігментації зубів лише за один тиждень* спеціальна ромбоподібна ділянка з густих щетинок на насадці w2 optimal white усуває поверхневі п",
  "стильний дизайн, ефективність і комфорт тостер russell hobbs 26060-56 honeycomb - монохромна, лаконічна, функціональна модель з обтічним дизайном, яка стане спр",
  "стильна та функціональна кухонна витяжка eleyus into 960 від українського бренду eleyus ефективно очистить повітря у вашій кухні, щоб вам дихалося на повні груд",
  "надзвичайно м’які щетинки дбайливе очищення для чутливих зубів і ясен. ретельне очищення може бути ніжним. ця насадка має унікальний дизайн з довгими, тонкими т",
  "компактний і портативний компактний дизайн іригатора має розкладний резервуар, який зручно очистити або взяти із собою в подорож. резервуар вміщує до 200 мл вод",
  "продуктивна турбіна, чисте повітря на кухні надокучають дим, пара та неприємні запахи на кухні? продуктивна турбіна потужністю 700 м³/год ефективно впорається з",
  "до 2 разів краще усунення нальоту порівняно зі звичайною зубною щіткою відчуйте чистоту philips sonicare. ця насадка для щітки має контурні щетинки w-подібної ф",
  "smart tab представляємо інноваційний механізм відкривання, що забезпечує швидкий і легкий доступ до ваших страв, встановлюючи новий стандарт зручності кухонних ",
  "eleyus breeze 470 60 - це телескопічна витяжка від тм eleyus, одна з новинок 2020 року. ця витяжка є інженерно-конструкторським рішенням, яке дозволило досягти ",
  "багатофункціональна форма для запікання, яка має дві окремі частини, що виконують різні функції: форма для запікання (нижня частина), сковорода-гриль (верхня ча",
  "кондиціонери серії comfort ніяких компромісів кондиціонери ergo серії comfort представлено 3 моделями: ergo ac 0703 swн ergo ac 0903 swн ergo ac 1203 swн вони п",
  "особливості сковорідок oscar nest: корпус виготовлений з високоякісного алюмінію, товщина 3.2 мм. внутрішнє суперстійке тришарове антипригарне покриття marble. ",
  "світлодіодна підсвітка світлодіоди забезпечують гарне та ефективне підсвічування варильної поверхні та є важливим естетичним і функціональним елементом на кухні",
  "килимок для сушіння посуду 38х51 см торгової марки soho виготовлений зі 100% поліестеру та губки, що забезпечує миттєве вбирання вологи та швидке висихання. має",
  "прості та зручні ваги в елегантному лаконічному дизайні tefal premiss — це електронні підлогові ваги, які зручно та легко використовувати щодня. завдяки функції",
  "універсальне рішення для збереження свіжості продуктів вакууматор ergo — це зручний і практичний прилад для тих, хто хоче завжди мати під рукою запас свіжих про",
  "інтерактивний додаток sonicare for kids завдяки зубній щітці philips sonicare for kids і додатку діти самі вчаться правильно чистити зуби. додаток синхронізуєть",
  "особливості сковорід oscar verona: корпус виготовлений з високоякісного алюмінію, товщина стінок 4 мм внутрішнє стійке антипригарне покриття зовнішнє cуперстійк",
  "особливості сковорід oscar verona: корпус виготовлений з високоякісного алюмінію, товщина стінок 3 мм внутрішнє стійке антипригарне покриття зовнішнє cуперстійк",
  "з мультимейкером ultracompact 3в1 sw383d10 від tefal насолоджуйтесь смачними закусками щодня. цей багатофункціональний прилад поєднує у собі вафельницю, сендвіч",
  "особливості сковорідок oscar best offer: корпус виготовлений з високоякісного алюмінію, товщина стінок 2,5 мм внутрішнє і зовнішнє надстійке тришарове антиприга",
  "потужний bldc двигун: швидке сушіння за 3 хвилини або менше* сушіть волосся за кілька хвилин за допомогою нашого найпотужнішого високошвидкісного фена. найсучас",
  "сучасні грилі russell hobbs george foreman ідеально підходять для поціновувачів гарячої їжі з апетитною скоринкою, яка ось-ось запеклася на розпеченій пластині ",
  "серія pyrex supreme це м'які, округлі лінії і простий лаконічний дизайн. форми для випікання pyrex supreme виготовлені з високоякісної екологічно чистої керамік",
  "компанія trend glass sp. z o.o. є приватним виробником скляного посуду в радомі, польща, заснованою у 2003 році, однак перші зв'язки її власників зі скляною про",
  "попрощайтеся з нальотом ця електрична зубна щітка має насадку intercare. подовжені щетинки сприяють видаленню більшої кількості нальоту між зубами та у важкодос",
  "особливості сковорід oscar master: корпус виготовлений з високоякісного алюмінію, товщина стінок 4 мм внутрішнє стійке антипригарне покриття non-stick зовнішнє ",
  "з 1968 року бренд cristal d'arques paris втілює в собі французьку елегантність і красу, доступні всім. залишаючись вірним своїм цінностям, бренд відтепер просув",
  "кондиціонери серії advance plus ніяких компромісів кондиціонери серії advance plus - це моделі спліт-систем з повним інверторним керуванням: dс-інверторний комп",
  "з 1968 року бренд cristal d'arques paris втілює в собі французьку елегантність і красу, доступну всім. залишаючись вірним своїм цінностям, бренд відтепер просув",
  "великі можливості надійної класики великі можливості надійної класики зручна система керування таймер на 30 хвилин функція розморожування 6 рівнів потужності сп",
  "хочете дбати про своє волосся і при цьому домогтися укладки салонної якості? у цьому вам допоможе фен supercare pro 2200 ac у чорному кольорі з бронзовими встав",
  "автоматична кавомашина krups harmony ea5088e0 — ідеальна кава стає простою. від рістрето до фільтр-кави, усе, що потрібно, — це простий поворот регулятора, а см",
  "бренд chef & sommelier належить компанії arc international - лідеру серед виробників скляного посуду. серед колекцій chef & sommelier є свої келихи для кожного ",
  "ringel - бренд качественной посуды и аксессуаров для кухни торговая марка ringel - пример лучшего опыта европейских производителей посуды и умение обеспечить ма",
  "серія macassar – це втілення елегантності і стилю французького шику. . келихи macassar - це елегантні та стильні аксесуари до будь-якої події. їх дизайн і атмос",
  "один дотик, і ви насолоджуєтеся чотирма напоями насолоджуйтеся чотирма популярними видами кави: від класичного еспресо, звичайної чорної кави до капучино з ідеа",
  "ніколи ще наш продукт не був таким привабливим, як з точки зору дизайну, так і ефективності стайлінгу. щипці proluxe виконані в сочетании кольорів перламутровог",
  "steambake для смачної випічки завдяки steambake домашня випічка смакуватиме так само добре, як і в професійній пекарні. вологість дозволяє тісту піднятися повні",
  "основні характеристики продукту: об'єм 1,7 л прозорий покажчик рівня води автоматичне відкриття кришки знімний і миючий фільтр від забруднень та накипу нагрівал",
  "насадки для щітки w2 optimal white в комплекті насадка для зубної щітки w2 optimal white ідеально підходить для тих, хто хоче вийти за межі ретельного чищення, ",
  "створена для ваших кулінарних перемог створена для ваших кулінарних перемог легке і зручне керування 5 режимів нагріву з конвекцією і грилем регулювання темпера",
  "електрочайник tefal thermo protect ідеально підходить для всієї родини. подвійні стінки зберігають воду всередині гарячою, а зовнішню поверхню ― прохолодною, то",
  "попрощайтеся з нальотом ця електрична зубна щітка має в комплекті насадку для освітлення кольору зубів. щільно розташовані щетинки забезпечують до 5 разів ефект",
  "стиль і функціональність - ідеальне поєднання ємності для сипучих продуктів серії kora - зручний і функціональний посуд для любителів вишуканості та стилю. само",
  "келихи lady diamond – це невід’ємна частина французького шику і мистецтва жити красиво. вони втілюють в собі французьку елегантність і красу, доступні всім. зав",
  "серія rendez-vous – це втілення елегантності та стилю французького шику. келихи вирізняються своєю неперевершеною формою, заворожуючими гранями та різьбленою ст",
  "детальна стрижка волосся в носі, бровах і вухах лінійний тример nee допомагає безпечно підстригати навколо складних ділянок, таких як ніс, вуха та брови. 3-денн",
  "моделі mini - маленькі, але надійні компаньйони для комфортного проживання. компактні водонагрівачі об’ємом від 10 до 15 літрів, які можна встановити як під рак",
  "в електричних водонагрівачах серії gbf ua втілений багатий практичний досвід у поєднанні з найсучаснішими технологіями. «сухий» нагрівальний елемент, розташован",
  "цей елегантний плаский водонагрівач пропонує оптимальний баланс між використовуваним простором і продуктивністю. завдяки інтелектуальній функції ecosmart збільш",
  "prime m - класичні водонагрівачі, які пропонують максимальну продуктивність з простим регулюванням температури, який встановлено зовні на корпусі. у водонагріва",
  "особливості: вимірює об'єм жиру та води в тілі за принципом bia: - жир% - вода% дизайн ultra slim (висота всього 20 мм) скляна поверхня для зручного чищення заг",
  "посуд pyrex - вибір практичних господинь. він не лише прослужить набагато довше, ніж інший посуд на кухні, але і не втратить свій зовнішній вигляд. серія daily ",
  "пральна машина 600 sensicare визначає розмір завантаження — від одного кілограма до повного, — налаштовуючи відповідно час прання, використання води та енергії.",
  "новий модельний ряд у класі енергоефективності с з мінімалістичним дизайном. технології: crystaltech емаль, що забезпечує тривалий термін служби водонагрівача i",
  "кондиціонери серії advance ефективні в будь-якому кліматі кондиціонери ergo серії advance представлено 5 інверторними моделями: ergo aci 0723 swн wifi ergo aci ",
  "міцна та надійна вішалка idea home створена спеціально для важкого одягу — пальт, курток, піджаків та інших об’ємних речей. вона допомагає зберігати форму одягу",
  "ароматизатор electrolux e2wasf00 надає одягу приємний аромат зеленого чаю з цитрусовими нотками бергамоту, вербени та лимона. він чудово підійде для використанн",
  "найкраще поєднання стильного дизайну, якості і функціональності для вашої кухні найкраще поєднання стильного дизайну, якості і функціональності для вашої кухні ",
  "велика місткість. більше місця для зберігання в тому ж просторі холодильники hisense з великою місткістю забезпечують зберігання їжі будь-якою форми, розміру та",
  "малолітражні та компактні водонагрівачі серії simpateco м54 представлені об’ємами 10 і 15 літрів моделями для встановлення як під раковиною, так і над раковиною",
  "ручний блендер з універсальними функціями що дозволять по максимуму заощадити час і місце на кухні. потужність мотора в 1200 вт забезпечує чудові результати, як",
  "холодильник-морозильник 800 cooling 360° оснащено передовою системою циркуляції повітря. завдяки оптимальному розташуванню вентиляційних отворів спеціально розр",
  "особливості: бездротова дія від вбудованого заряджуваного акумулятора три незалежні поворотні головки з можливістю заміни користувачем речі фрези зі збільшеним ",
  "інфрачервоні обігрівачі ergo інфрачервоний обігрівач ergo - прекрасне рішення для швидкого та ефективного локального обігріву великих закритих приміщень і напів",
  "ультратонкий дизайн (висотою всього 16 мм) скляна поверхня полегшує догляд за ними великий рк-дисплей (55 x 25 мм) загартоване захисне скло (4 мм) зважування до",
  "особливості: скляна поверхня для зручного та гігієнічного догляду загартоване безпечне скло (5 мм) тонка модель (висота 21 мм) максимальна вага до 150 кг (визна",
  "auto wash. просте використання автоматичної програми функція auto автоматично розпізнає вашу білизну та налаштовує цикли прання для індивідуального прання. прог",
  "сушарка для посуду розсувна violet house 0697 — це зручний кухонний аксесуар для сушіння тарілок, столових приборів та іншого посуду після миття. розсувна конст",
  "менше безладу, краще змішування ручний міксер swirl turquoise є приладом, який беззаперечно вартує уваги. завдяки новій високоефективній технології вінчиків hel",
  "серія i-pro 3 пральна машина серії i-pro 3 пропонує індивідуально налаштовані та технологічно вдосконалені рішення для виняткових і вражаючих результатів прання",
  "електрична варильна поверхня whirlpool akt 8210 lx виглядатиме стильно та сучасно на вашій кухні. побачивши індикатор, що світиться, ви будете знати, що конфорк",
  "відмінні результати на панелі керування у верхній частині міксера знаходяться перемикач для ввімкнення та вимкнення, кнопки вибору швидкості та ввімкнення імпул",
  "потужне всмоктування для різних приміщень контейнерний пилосос lg забезпечує потужне всмоктування та ефективне прибирання. *зображена насадка наведена з демонст",
  "1200 вт чистої потужності дроблення з легкістю змішуйте навіть найтвердіші інгредієнти за допомогою нашого найпотужнішого ручного блендера. миттєво насолоджуйте",
  "велика робоча поверхня багато місця для каструль на збільшеній (до 20%) варильній поверхні зі збільшеною відстанню між пальниками помістяться каструлі та сковор",
  "тм qutu - це втілення 40-річного досвіду компанії hisar kalip - одного з найбільших турецьких виробників товарів із пластику. унікальною рисою товарів тм qutu є",
  "допомагає запобігти захворюванням ясен, карієсу, утворенню зубного каменю та неприємному запаху з рота інтелектуальна панель відображення 5 режимів: м'який, ком",
  "водонагрівачі обладнані «сухим» нагрівальним елементом і зовнішнім механічним регулятором температури. моделі серії comfort u мають збільшений шар теплоізоляції",
  "міцний і потужний двигун 1000 вт. контейнер з нержавіючої сталі ємністю 4,5 л для всіх видів тіста (0,8 кг для твердого тіста, 2,2 л для м'якого тіста). 6 парам",
  "конвертований контейнер freshzone готовий до будь-якої події зручний контейнер просто змінює призначення зі зберігання риби та м'яса на зберігання фруктів та ов",
  "плоский нагрівальний елемент для швидкого кип'ятіння вбудований нагрівальний елемент з нержавіючої сталі забезпечує швидке кип'ятіння і просту чистку. мікрофіль",
  "кухонні електронні ваги sencor sks 4004 в яскравому кольорі стануть повсякденним помічником на вашій кухні. для максимальної зручності користувача, ваги оснащен",
  "ножі серії sushi silver відносяться до професійних високоякісних ножів, завдяки особливому підбору матеріалів і технології виготовлення. створені майже дві тися",
  "універсальний тример 15-в-1 з максимальною точністю тример комплектується 15 інструментами, щоб ви могли підстригати та стилізувати бороду, волосся і доглядати ",
  "trend glass sp. z o.o. є приватним виробником скляного посуду в радомі, польща, заснована у 2003 році, однак перші зв'язки її власників зі скляною промисловістю",
  "мотор постійного струму економічний і надійний надійний потужний мотор вас не підведе. він заощадить електроенергію і прослужить довго. знімна насадка-блендер п",
  "корисні задоволення тепер можна насолоджуватися смачною хрусткою картоплею фрі без зайвих калорій. цей режим запікання за допомогою гарячого повітря не вимагає ",
  "особливості: споживана потужність 2000 вт ультралегка конструкція 3 рівні встановлення температури 2 рівні встановлення швидкості повітряне сопло дифузор кнопка",
  "компанія bager турецький бренд, який виготовляє пластикові пляшки з 2005 року. з кожним днем, виробляючи продукцію на сучасному обладнанні, виготовляючи пластик",
  "суперсушіння з технологією ші визначаючи рівень вологості вашого одягу, сушильна машина розумно підбирає правильний цикл сушіння для кожного завантаження. вона ",
  "ідеально підходить для стабільно високої ефективності оригінальний фільтр philips було розроблено разом із самим пристроєм для забезпечення ідеальної сумісності",
  "особливості: лезо з нержавіючої сталі 4 насадки з гребінцями (3, 6, 9 і 12 мм) можливість підрівнювання без використання насадки з гребінцем регулятор налаштува",
  "пральна машина steamcare швидко освіжає навіть делікатний одяг, якому не потрібне повне прання. а пара допомагає усунути складки та неприємні запахи. * за резул",
  "особливості: споживана потужність: 2000 вт ультратонкий дизайн 3 параметри температури 2 рівні швидкості насадка кнопка холодного повітря знімні задні решітки д",
  "вражаюча потужність праска виробляє на 25% більше пари порівняно з аналогічними прасками tefal попереднього покоління, гарантуючи високу продуктивність день за ",
  "функція «тара» зручне зважування ця корисна функція допомагає точно зважувати інгредієнти. встановіть миску на ваги та натисніть на кнопку тари, щоб обнулити ва",
  "інтуїтивне управління подвійний перемикач керуйте приготуванням їжі швидше та простіше. два поворотні перемикачі дозволяють встановлювати час, вагу або потужніс",
  "простий і швидкий монтаж без зайвих зусиль ізольовані кріплення та відсутність необхідності у вимірюваннях. лише викрутка — і 15 хвилин до готовності. зберігайт",
  "посуд pyrex – вибір практичних господарок. він не лише прослужить набагато довше, ніж інший посуд на кухні, але й не втратить свого вигляду. абсолютна гладка, н",
  "легкоочищуване покриття easyclean спеціальне легкоочищуване покриття lg easyclean стійке до механічних пошкоджень і вбирання жиру, завдяки чому частинки їжі не ",
  "bigsurface: велика робоча поверхня багато місця для каструль на просторій варильній поверхні зі збільшеною відстанню між пальниками помістяться каструлі та сков",
  "економічний і надійний надійний потужний двигун вас не підведе. він заощадить електроенергію та прослужить довго. просте використання та очищення після завершен",
  "східчаста форма homemade plus ідеальна духовка для професійних результатів духовка стала ще просторішою, а стеля більш східчастою, повторюючи конструкцію традиц",
  "пилососить і миє за один раз, прибирає пил і бруд без зусиль робот пилососить і миє тверду підлогу за один раз, видаляючи тонкий шар пилу, який щодня накопичуєт",
  "лагідне чищення для захисту дитячих усмішок переконайтеся, що ваша дитина почувається комфортно, розвиваючи корисну звичку до чищення зубів і запобігаючи карієс",
  "потужна витяжка – свіже та чисте повітря турбіна продуктивністю 800 м³/год впорається з усім зайвим у кухні площею до 19 м². вмикайте витяжку до початку готуван",
  "оригінальний контейнер для попкорну herevin зробить перегляд фільмів або вечірки ще приємнішими! виготовлений з міцного пластику, легкий, практичний і простий у",
  "до 7 разів здоровіші ясна за два тижні* ефективний догляд за яснами вимагає максимального контакту щітки з лінією ясен під час очищення. заокруглений профіль на",
  "3 до 1 за допомогою функції \"3 в 1\" посудомийна машина автоматично визначає, який вид миючого засобу використовується - звичайний набір або таблетка \"3 в 1\", і ",
  "розмір підходить для двох осіб на двоспальному ліжку (160 х 140 см) 2 незалежні пульти дистанційного керування 2 температурні режими рекомендований час попередн",
  "bigspace: простора духовка об'єм 77 літрів готуйте страви значних розмірів? завдяки інноваційній конструкції духовка стала більшою і ширшою. на деках тепер міст",
  "особливості: технологія direct drive дозволяє під час заряджання акумулятора працювати з приладом, під'єднаним до ел. розетки при зарядці прилад працює безпосер",
  "смачне спінене молоко завдяки класичному піноутворювачу класичний піноутворювач розподіляє каву для легкого приготування ніжної молочної піни для капучино. крім",
  "високошвидкісний професійний bldc мотор максимальна швидкість: 110000 rpm рівні температур: 4 швидкість потоку повітря: 2 параметри холодний потік для зміцнення",
  "особливості: об'єм: 1,7 л споживана потужність: 2 200 вт центральний конектор 360° strix з триступінчатим захисним запобіганням без трубки для пари - просте очи",
  "cooldoor3 завдяки тепловідбивному склу з внутрішньої сторони дверцят, а також їх потрійному склінню, ми домоглися значного зниження температури їх зовнішньої по",
  "висока якість і функціональність, бездоганний стиль і простота у використанні - усе це характеризує продукцію тм eleyus . одним із досягнень команди інженерів-р",
  "особливості: володіє силою для подрібнення м'яса, фруктів, овочів і продуктів інших видів також підходить для приготування пюре та дитячого харчування 4 титанов",
  "серія prowash 500 нова пральна машина candy prowash 500 розроблена для тривалої експлуатації. відкрийте для себе надійне та екологічне рішення для прання завдяк",
  "інверторний кондиціонер. максимальна продуктивність завдяки передовим технологіям інверторна технологія постійного струму 360° — це набір передових технологій, ",
  "потужна витяжка – свіже та чисте повітря турбіна продуктивністю 800 м³/год впорається з усім зайвим у кухні площею до 19 м². периметральне втягування забирає по",
  "універсальний тример 10-в-1 з максимальною точністю тример комплектується 10 інструментами, щоб ви могли підстригати та стилізувати бороду, волосся і доглядати ",
  "класичний стиль, сучасні технології класичні форми купольної витяжки гармонійно вливаються в інтер’єр і додають кухонній атмосфері домашнього затишку. міцний ст",
  "особливості: інноваційне рішення в акумуляторних пилососах black+decker: система знімного акумулятора дозволяє використовувати акумулятори з іншої техніки й інс",
  "двигун постійного струму з тривалим терміном служби споживана потужність 2000 вт 3 ступені настройки температури 2 швидкості, що гарантують бездоганний повітрян",
  "пакети для вакуумування складаються з двошарової плівки. зовнішній шар - поліамід - забезпечує герметичність і непроникність. внутрішній шар - поліетилен має ри",
  "рівномірне готування з функцією multilevel насолоджуйтесь рівномірним приготуванням страв завдяки функції multilevel. додаткове нагрівальне кільце забезпечує рі",
  "великий об'єм 700 л = 36 пакетів з покупками. зберігайте фрукти й овочі свіжими довше humidity zone — автоматичне підтримання вологості до 90% для збереження св",
  "особливості: об'єм 3,2 л/1,4 кг картоплі фрі кришка з оглядовим отвором для повного контролю за приготуванням страви регульований термостат від 130 °c до 190 °c",
  "відкрийте для себе повний набір для сніданку набір для сніданку, розроблений із думкою про те, що дійсно має значення. відкрийте для себе повний набір, що включ",
  "міцні чавунні решітки чавунні решітки - це практичне та сучасне рішення. стійкі, міцні, їх легко утримувати в чистоті, вони гарантують просте та безпечне викори",
  "безкомпромісна швидкість та естетика безкомпромісна швидкість та естетика дві незалежні зони приготування соус і гарніри одночасно — кожна конфорка зі своїм реж",
  "asimetria - інноваційний і сучасний модельний ряд продукції для випікання, яка забезпечує необхідну функціональність від стадії готування до зберігання продукті",
  "контролер strix/otter немає довговічного електрочайника без відповідного контролера - тобто без системи, що відповідає за передачу енергії між підставкою чайник",
];

/** True when the description is a shared supplier template. */
export function isBoilerplateDescription(html: string | null | undefined): boolean {
  const plain = htmlToPlainText(html).toLowerCase();
  if (plain === '') return false;
  // V1/V2 (audit 2026-08-31 + Task #23): marker may sit anywhere in the text.
  if (BOILERPLATE_MARKERS.some((marker) => plain.includes(marker))) return true;
  // V3 (Task #25): template heads are matched by PREFIX on the meta window —
  // the first 160 chars of the plain text (prefixes are ≤160 chars, so the
  // cap never truncates a prefix mid-way).
  const head = plain.slice(0, 160);
  return BOILERPLATE_PREFIXES.some((prefix) => head.startsWith(prefix));
}

export interface ProductMetaDescriptionInput {
  productName: string;
  shortDescription?: string | null;
  description?: string | null;
}

/**
 * Meta description for a product page. Chain: short_description →
 * unique description (capped at 160) → generic name-based template.
 * Always returns a non-empty string (the page previously fell back to the
 * same template inline).
 */
export function buildProductMetaDescription(
  input: ProductMetaDescriptionInput
): string {
  const cap = (text: string): string | undefined => {
    const plain = htmlToPlainText(text);
    return plain ? plain.slice(0, 160) : undefined;
  };
  return (
    cap(input.shortDescription ?? '') ??
    (!isPlaceholderDescription(input.description) &&
    !isBoilerplateDescription(input.description)
      ? cap(input.description ?? '')
      : undefined) ??
    `Купити ${input.productName} в інтернет-магазині ${SITE_NAME}.`
  );
}

// ---------------------------------------------------------------------------
// PDP <title> compaction (audit R3 2026-09-15): supplier names up to ~149
// chars pushed «name — Товари для дому» far past the ~60-char SERP window
// (1 934 eligible products over budget at audit time). Builds a shorter
// title name from the REAL name tokens only — leading type words + brand +
// the digit-bearing model token — and falls back to a word-boundary
// truncation when no structure is found. Honesty rule (same as the JSON-LD
// builders): every emitted token comes from the product name / brand;
// nothing is invented. The visible H1 and og:title keep the FULL name.
// ---------------------------------------------------------------------------

/** Name budget so «name — Товари для дому» stays inside the ~60-char window. */
const PRODUCT_TITLE_NAME_BUDGET = 48;

/** Last token that carries a digit and ≥4 significant chars — model numbers
 * («FV5718E0», «BCD-456WYR», «(P2947)») live there. Short digit runs
 * («6», «/19», «60», «12») are sizes/counts, never the model. */
function modelTokenOf(tokens: readonly string[]): string | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const raw = tokens[i] ?? '';
    const inner = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (inner.length >= 4 && /\d/.test(inner)) return raw.replace(/[,;]+$/, '');
  }
  return null;
}

function isTypeWord(token: string): boolean {
  return !/\d/.test(token) && token.length > 1;
}

export function buildProductTitleName(
  name: string,
  opts: { brandName?: string | null } = {}
): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= PRODUCT_TITLE_NAME_BUDGET) return trimmed;

  const tokens = trimmed.split(' ');
  const model = modelTokenOf(tokens);
  const brandName = opts.brandName?.trim();
  const brandIndex =
    brandName && brandName.length > 0
      ? tokens.findIndex((token) =>
          token.toLowerCase().includes(brandName.toLowerCase())
        )
      : -1;

  if (brandIndex >= 0 || model) {
    const brand = brandIndex >= 0 ? (tokens[brandIndex] ?? '') : '';
    // Type words: up to three non-digit words taken BEFORE the brand when
    // the name leads with the type («Праска TEFAL …»), or between the brand
    // and the model for brand-first names («TEFAL Бутербродниця SW383D10»).
    // With no brand at all, the words before the model serve as the type.
    const leading = (
      brandIndex >= 0 ? tokens.slice(0, brandIndex) : []
    )
      .filter(isTypeWord)
      .slice(0, 3);
    const between: string[] = [];
    if (brandIndex >= 0 && model) {
      const modelIndex = tokens.indexOf(model);
      for (let i = brandIndex + 1; i < modelIndex && between.length < 3; i++) {
        const token = tokens[i];
        if (token === undefined) break;
        if (isTypeWord(token)) between.push(token);
        else break;
      }
    }
    const beforeModel =
      brandIndex < 0 && model
        ? tokens
            .slice(0, tokens.indexOf(model))
            .filter(isTypeWord)
            .slice(-3)
        : [];
    let parts: string[];
    if (leading.length > 0) {
      parts = [leading.join(' '), brand, model ?? ''];
    } else if (between.length > 0) {
      // Brand-first name: the type words FOLLOW the brand in the name.
      parts = [brand, between.join(' '), model ?? ''];
    } else if (beforeModel.length > 0) {
      parts = [beforeModel.join(' '), model ?? ''];
    } else {
      parts = [brand, model ?? ''];
    }
    const candidate = parts
      .filter((part) => part.length > 0)
      .join(' ')
      .replace(/[\s,;:–—-]+$/, '');
    if (candidate.length > 0 && candidate.length <= PRODUCT_TITLE_NAME_BUDGET) {
      return candidate;
    }
  }

  // Honest fallback: word-boundary truncation of the real name.
  return truncateMetaDescription(trimmed, PRODUCT_TITLE_NAME_BUDGET);
}
