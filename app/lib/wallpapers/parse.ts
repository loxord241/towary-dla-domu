/**
 * Pure parsers for the 1C 7.7 wallpaper stock feed (wallpapers import, Task 3).
 *
 * Contract (plan 2026-09-10, spec §3):
 *  - parseWallpaperCsv — `;`-separated, optional header
 *    `code;name;article;unit;price_retail;qty`, BOM-tolerant, CRLF-tolerant.
 *    Numeric fields are strict (no signs/units/exponents); sanity windows
 *    aligned with the design spec §sanity (audit P2 2026-09-12): price
 *    50..5000 грн (live wc-* range 110..1400), qty 0..999; bad lines go to
 *    `errors` with 1-based physical line numbers
 *    — the function NEVER throws, and per-line reasons are aggregated into a
 *    single CsvError so the ingest endpoint can report "first 20" cleanly.
 *  - parseArticleTokens — article candidates from a free-form product name.
 *    Grammar pinned by real-inventory fixtures (tests/wallpaper-parse.test.ts):
 *      `N{3,4}-NN` (`6647-04`, `531-34`); `NNNN NN` -> `NNNN-NN` (bare NNNN
 *      suppressed); bare 4..7-digit numbers; alnum with latin+cyrillic letters
 *      [a-zа-яіїєґ] lowercased (`86000br90`, `163с27`, `рн105р15`);
 *      short (1-3 letter) prefixes glue across single spaces
 *      (`SP 531-34` -> `sp531-34` + inner `531-34`; `PH 206 P 84` -> `ph206p84`);
 *      a 4+ letter word attached to a number is a word, not a prefix
 *      (`Тінь3829-10` -> `3829-10`). Size fragments (`53см`, `10м`, `1,06`)
 *      never become tokens. Output is lowercased and deduplicated.
 *  - parseRollSize — `53см*10м`, `0,53*10м`, `1,06*10м`, `53см×15м`,
 *    `106х10`, `1,06х10,05м` (fractional length truncates to the nominal),
 *    `1,06 на 10м` («на» separator with surrounding spaces);
 *    separators `*` `×` `x` `х` normalized; only widthCm 53|106 and
 *    lengthM 10|15 are valid, anything else -> null.
 *
 * No Next.js / DB imports: this module is unit-tested with node:test and is
 * safe to reuse from the ingest route, the importer and the photo CLI.
 */

export interface RollSize {
  widthCm: 53 | 106;
  lengthM: 10 | 15;
}

export interface WallpaperRow {
  code: string;
  name: string;
  /** From the CSV `article` column as-is (trimmed), or null when empty. */
  article: string | null;
  rollSize: RollSize | null;
  priceRetail: number;
  qty: number;
}

export interface CsvError {
  /** 1-based physical line number in the file (header is line 1). */
  line: number;
  reason: string;
}

const EXPECTED_HEADER = ['code', 'name', 'article', 'unit', 'price_retail', 'qty'] as const;

// Spec sanity windows (docs/superpowers/specs/2026-09-10-wallpapers-import-
// design.md): a wall-paper roll never costs <50 or >5000 грн and qty never
// exceeds 999. Values outside mean a broken export line — rejected per-line.
const PRICE_MIN = 50;
const PRICE_MAX = 5000;
const QTY_MIN = 0;
const QTY_MAX = 999;

/** Plain unsigned number, `.` or `,` decimal separator (1C UA locale). */
const STRICT_NUMBER_RE = /^\d+(?:[.,]\d+)?$/;
const STRICT_INT_RE = /^\d+$/;

function splitLines(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
}

export function parseWallpaperCsv(text: string): { rows: WallpaperRow[]; errors: CsvError[] } {
  const rows: WallpaperRow[] = [];
  const errors: CsvError[] = [];
  const lines = splitLines(text);
  let firstNonEmptySeen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (line.trim() === '') continue;

    // Optional header: skipped only when the fields match exactly.
    if (!firstNonEmptySeen) {
      firstNonEmptySeen = true;
      const cells = line.split(';').map((c) => c.trim().toLowerCase());
      const matchesHeader =
        cells.length === EXPECTED_HEADER.length &&
        cells.every((cell, j) => cell === EXPECTED_HEADER[j]);
      if (matchesHeader) continue;
    }

    const fields = line.split(';');
    if (fields.length !== EXPECTED_HEADER.length) {
      errors.push({
        line: lineNo,
        reason: `expected ${EXPECTED_HEADER.length} ';'-separated columns, got ${fields.length}`,
      });
      continue;
    }

    const code = (fields[0] ?? '').trim();
    const name = (fields[1] ?? '').trim();
    const articleRaw = (fields[2] ?? '').trim();
    const priceRaw = (fields[4] ?? '').trim();
    const qtyRaw = (fields[5] ?? '').trim();

    const reasons: string[] = [];
    if (code === '') reasons.push('code is empty');
    if (name === '') reasons.push('name is empty');

    let price = Number.NaN;
    if (!STRICT_NUMBER_RE.test(priceRaw)) {
      reasons.push(`price_retail: not a plain number ("${priceRaw}")`);
    } else {
      price = Number(priceRaw.replace(',', '.'));
      if (price < PRICE_MIN || price > PRICE_MAX) {
        reasons.push(`price_retail: "${priceRaw}" out of range ${PRICE_MIN}..${PRICE_MAX}`);
      }
    }

    let qty = Number.NaN;
    if (!STRICT_INT_RE.test(qtyRaw)) {
      reasons.push(`qty: not a plain integer ("${qtyRaw}")`);
    } else {
      qty = Number(qtyRaw);
      if (qty < QTY_MIN || qty > QTY_MAX) {
        reasons.push(`qty: "${qtyRaw}" out of range ${QTY_MIN}..${QTY_MAX}`);
      }
    }

    if (reasons.length > 0) {
      errors.push({ line: lineNo, reason: reasons.join('; ') });
      continue;
    }

    rows.push({
      code,
      name,
      article: articleRaw === '' ? null : articleRaw,
      rollSize: parseRollSize(name),
      priceRetail: price,
      qty,
    });
  }

  return { rows, errors };
}

// ---------------------------------------------------------------------------
// parseRollSize
// ---------------------------------------------------------------------------

/**
 * Width and length around a separator (*, ×, x, х), units optional.
 * Width 0..2 is meters (0,53 / 1,06) and is converted to cm; 53/106 stay as-is.
 * Fractional lengths (10,05) floor to the nominal size.
 */
const ROLL_SIZE_RE =
  /(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:см|м)?\s*(?:[*×xх]+|\s+на\s+)\s*(\d{1,3}(?:[.,]\d{1,3})?)\s*м?(?![a-zа-яіїєґ0-9])/g;

const ROLL_WIDTHS = [53, 106] as const;
const ROLL_LENGTHS = [10, 15] as const;

function parsePlainNumber(raw: string): number {
  return Number.parseFloat(raw.replace(',', '.'));
}

export function parseRollSize(name: string): RollSize | null {
  const lower = name.toLowerCase();
  for (const m of lower.matchAll(ROLL_SIZE_RE)) {
    const widthRaw = m[1];
    const lengthRaw = m[2];
    if (widthRaw === undefined || lengthRaw === undefined) continue;
    const widthValue = parsePlainNumber(widthRaw);
    const widthCm = Math.round(widthValue < 3 ? widthValue * 100 : widthValue);
    const lengthM = Math.floor(parsePlainNumber(lengthRaw));
    if (
      (ROLL_WIDTHS as readonly number[]).includes(widthCm) &&
      (ROLL_LENGTHS as readonly number[]).includes(lengthM)
    ) {
      return { widthCm: widthCm as RollSize['widthCm'], lengthM: lengthM as RollSize['lengthM'] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// parseArticleTokens
// ---------------------------------------------------------------------------

const LETTER_RE = /[a-zа-яіїєґ]/;
const ALNUM_TAIL_RE = /[a-zа-яіїєґ0-9]/;
const CHUNK_RE = /[a-zа-яіїєґ0-9]+(?:-[a-zа-яіїєґ0-9]+)*/g;
const SHORT_LETTERS_RE = /^[a-zа-яіїєґ]{1,3}$/;
const LONG_LETTERS_RE = /^[a-zа-яіїєґ]{4,}$/;
const DASH_ARTICLE_RE = /^\d{3,4}-\d{2}$/;
/** Word-prefixed number: `тінь3829-10` -> `3829-10`, `тень531-34` -> `531-34`. */
const WORD_PREFIXED_NUMBER_RE = /(?<!\d)\d{3,4}(?:-\d{2})?(?!\d)/;

interface Chunk {
  text: string;
  start: number;
  end: number;
}

const isDigits = (s: string): boolean => /^\d+$/.test(s);

/** Full alnum article shape: mixed letters+digits, >=4 digits, ends with a digit. */
function isAlnumArticle(s: string): boolean {
  if (!LETTER_RE.test(s) || !/\d/.test(s)) return false;
  if ((s.match(/\d/g) ?? []).length < 4) return false;
  const firstLetter = s.search(LETTER_RE);
  if (!/\d/.test(s.slice(firstLetter + 1))) return false;
  return /\d$/.test(s);
}

/** Length of the letter run immediately before the first digit (0 if none). */
function lettersBeforeFirstDigit(s: string): number {
  const firstDigit = s.search(/\d/);
  if (firstDigit <= 0) return 0;
  let i = firstDigit;
  while (i > 0 && LETTER_RE.test(s.charAt(i - 1))) i--;
  return firstDigit - i;
}

export function parseArticleTokens(name: string): string[] {
  const lower = name.toLowerCase();
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (token !== '' && !seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  };

  const chunks: Chunk[] = [];
  for (const m of lower.matchAll(CHUNK_RE)) {
    const text = m[0] ?? '';
    const start = m.index ?? 0;
    chunks.push({ text, start, end: start + text.length });
  }
  const consumed = chunks.map(() => false);
  const gapIsSpace = (a: Chunk, b: Chunk): boolean =>
    b.start - a.end === 1 && lower.charAt(a.end) === ' ';

  // Pass 1: `NNNN NN` combos -> `NNNN-NN` (bare NNNN suppressed via `consumed`).
  // The second group must not be a size/unit tail (`1598 53см` is not a combo).
  for (let i = 0; i + 1 < chunks.length; i++) {
    const a = chunks[i] ?? { text: '', start: 0, end: 0 };
    const b = chunks[i + 1] ?? { text: '', start: 0, end: 0 };
    if (
      isDigits(a.text) &&
      a.text.length === 4 &&
      isDigits(b.text) &&
      b.text.length === 2 &&
      gapIsSpace(a, b) &&
      !ALNUM_TAIL_RE.test(lower.charAt(b.end))
    ) {
      push(`${a.text}-${b.text}`);
      consumed[i] = true;
      consumed[i + 1] = true;
    }
  }

  // Pass 2: glue chains starting with a 1-3 letter prefix (`sp 531-34`,
  // `рн 213р97`, `ph 206 p 84`). Chains break at 4+ letter words
  // (`світло`, `обоі`) and at combo-consumed chunks; a trailing short-letter
  // fragment only joins when the next chunk carries digits (else `1598 беж`
  // would swallow the real token). Directly-attached prefixes are NOT chains:
  // `sp515-13` is one chunk and suppresses its inner `NNNN-NN`, while the
  // space form keeps both (`sp531-34` + `531-34`) — per real inventory.
  let i = 0;
  while (i < chunks.length) {
    const head = chunks[i];
    if (head === undefined || consumed[i] || !SHORT_LETTERS_RE.test(head.text)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < chunks.length) {
      const prev = chunks[j - 1] ?? { text: '', start: 0, end: 0 };
      const cur = chunks[j] ?? { text: '', start: 0, end: 0 };
      if (consumed[j] || !gapIsSpace(prev, cur) || LONG_LETTERS_RE.test(cur.text)) break;
      if (SHORT_LETTERS_RE.test(cur.text)) {
        const next = chunks[j + 1];
        if (next === undefined || !/\d/.test(next.text)) break;
      }
      j++;
    }
    if (j - i >= 2) {
      const glued = chunks
        .slice(i, j)
        .map((c) => c.text)
        .join('');
      if (isAlnumArticle(glued)) {
        push(glued);
        for (const c of chunks.slice(i, j)) {
          if (DASH_ARTICLE_RE.test(c.text)) push(c.text);
        }
        for (let k = i; k < j; k++) consumed[k] = true;
      }
      i = j;
    } else {
      i++;
    }
  }

  // Pass 3: remaining individual chunks.
  for (let k = 0; k < chunks.length; k++) {
    if (consumed[k]) continue;
    const text = chunks[k]?.text ?? '';
    if (text === '') continue;
    if (isDigits(text)) {
      // Bare numbers: 4-digit singles (1598, 5070) up to 7 digits (30202).
      if (text.length >= 4 && text.length <= 7) push(text);
      continue;
    }
    if (DASH_ARTICLE_RE.test(text)) {
      push(text);
      continue;
    }
    if (!LETTER_RE.test(text) || !/\d/.test(text)) continue; // words, units (`10м`)
    if (lettersBeforeFirstDigit(text) >= 4) {
      // A real word glued to a number (`Тінь3829-10`) — the number is the token.
      const inner = text.match(WORD_PREFIXED_NUMBER_RE);
      if (inner !== null) push(inner[0] ?? '');
      continue;
    }
    if (isAlnumArticle(text)) push(text); // 86000br90, 163с27, рн105р15, sp515-13
  }

  return tokens;
}
