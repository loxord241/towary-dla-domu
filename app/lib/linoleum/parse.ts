/**
 * Pure parser for the 1C linoleum stock feed (linoleum vertical, batch 1;
 * task L2, 2026-09-17). Mirrors app/lib/wallpapers/parse.ts with the
 * linoleum CSV contract.
 *
 * Contract (`code;name;width_m;price_sqm;qty_m`):
 *  - parseLinoleumCsv — `;`-separated, optional header line, BOM-tolerant,
 *    CRLF-tolerant, fields trimmed. Numeric fields are strict (no signs/
 *    units/exponents):
 *      * width_m — roll width, STRICTLY one of LINOLEUM_WIDTHS_M
 *        (1.5 | 2 | 2.5 | 3 | 3.5 | 4 м); decimal comma AND dot accepted
 *        ("2,5" == "2.5", "2" == "2,0"). A width outside the real product
 *        grid means a broken export line — it is rejected, never guessed;
 *      * price_sqm — price per m² in грн. Sanity window 10..100000:
 *        live retail linoleum (бытовой/полукоммерческий) sits around
 *        ~100..3000 грн/м², so the window keeps a ≥30x margin on both
 *        sides while still catching unit mistakes (price per roll / per
 *        pallet / копейки / потерянный разделитель тысяч);
 *      * qty_m — stock in WHOLE running meters, 0..99999. The 1C export
 *        counts linoleum stock in whole meters — fractional strings are
 *        rejected as an upstream units bug.
 *  - A line is valid ⇔ ALL its fields are valid; bad lines land in
 *    `errors` with 1-based physical line numbers — the function NEVER
 *    throws and a bad line never fails the whole file.
 *  - Duplicate codes are NOT deduplicated here: same policy as wallpapers,
 *    the import-plan layer resolves them («последний выигрывает»).
 *
 * No Next.js / DB imports: this module is unit-tested with node:test and
 * is safe to reuse from the ingest route and the future linoleum importer.
 */

export const LINOLEUM_WIDTHS_M = [1.5, 2, 2.5, 3, 3.5, 4] as const;
export type LinoleumWidthM = (typeof LINOLEUM_WIDTHS_M)[number];

// See module doc: sanity windows for price (грн/м²) and whole-meter qty.
export const LINOLEUM_PRICE_SQM_MIN = 10;
export const LINOLEUM_PRICE_SQM_MAX = 100000;
export const LINOLEUM_QTY_M_MIN = 0;
export const LINOLEUM_QTY_M_MAX = 99999;

export interface LinoleumRow {
  code: string;
  name: string;
  widthM: LinoleumWidthM;
  priceSqm: number;
  qtyM: number;
}

export interface CsvError {
  /** 1-based physical line number in the file (header is line 1). */
  line: number;
  reason: string;
}

const EXPECTED_HEADER = ['code', 'name', 'width_m', 'price_sqm', 'qty_m'] as const;

const WIDTH_SET: ReadonlySet<number> = new Set<number>(LINOLEUM_WIDTHS_M);

/** Plain unsigned number, `.` or `,` decimal separator (1C UA locale). */
const STRICT_NUMBER_RE = /^\d+(?:[.,]\d+)?$/;
const STRICT_INT_RE = /^\d+$/;

function splitLines(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
}

export function parseLinoleumCsv(text: string): { rows: LinoleumRow[]; errors: CsvError[] } {
  const rows: LinoleumRow[] = [];
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
    const widthRaw = (fields[2] ?? '').trim();
    const priceRaw = (fields[3] ?? '').trim();
    const qtyRaw = (fields[4] ?? '').trim();

    const reasons: string[] = [];
    if (code === '') reasons.push('code is empty');
    if (name === '') reasons.push('name is empty');

    let width: LinoleumWidthM | null = null;
    if (!STRICT_NUMBER_RE.test(widthRaw)) {
      reasons.push(`width_m: not a plain number ("${widthRaw}")`);
    } else {
      const value = Number(widthRaw.replace(',', '.'));
      // All set members are exactly representable in binary floating point,
      // so the Set lookup is an exact comparison (no epsilon needed).
      if (!WIDTH_SET.has(value)) {
        reasons.push(
          `width_m: "${widthRaw}" is not one of ${LINOLEUM_WIDTHS_M.join(', ')}`
        );
      } else {
        width = value as LinoleumWidthM;
      }
    }

    let price = Number.NaN;
    if (!STRICT_NUMBER_RE.test(priceRaw)) {
      reasons.push(`price_sqm: not a plain number ("${priceRaw}")`);
    } else {
      price = Number(priceRaw.replace(',', '.'));
      if (price < LINOLEUM_PRICE_SQM_MIN || price > LINOLEUM_PRICE_SQM_MAX) {
        reasons.push(
          `price_sqm: "${priceRaw}" out of range ${LINOLEUM_PRICE_SQM_MIN}..${LINOLEUM_PRICE_SQM_MAX}`
        );
      }
    }

    let qty = Number.NaN;
    if (!STRICT_INT_RE.test(qtyRaw)) {
      reasons.push(`qty_m: not a plain integer ("${qtyRaw}")`);
    } else {
      qty = Number(qtyRaw);
      if (qty < LINOLEUM_QTY_M_MIN || qty > LINOLEUM_QTY_M_MAX) {
        reasons.push(`qty_m: "${qtyRaw}" out of range ${LINOLEUM_QTY_M_MIN}..${LINOLEUM_QTY_M_MAX}`);
      }
    }

    if (reasons.length > 0) {
      errors.push({ line: lineNo, reason: reasons.join('; ') });
      continue;
    }

    rows.push({ code, name, widthM: width!, priceSqm: price, qtyM: qty });
  }

  return { rows, errors };
}
