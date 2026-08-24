/**
 * Deterministic Ukrainian → Latin transliteration for stable slugs.
 * Pure module: no I/O, no env — unit-testable.
 *
 * Slug stability matters more than linguistic beauty: the Yugcontract
 * external id is always appended, so collisions are impossible even if
 * the transliteration table changes later.
 */

const MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie',
  ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '',
  ю: 'iu', я: 'ia',
  // leftover Cyrillic letters from other alphabets, mapped defensively
  ъ: '', ы: 'y', э: 'e', ё: 'e',
};

/** Apostrophes and soft-signs simply disappear; junk becomes '-'. */
function transliterate(input: string): string {
  let out = '';
  for (const ch of input.toLowerCase()) {
    const mapped = MAP[ch];
    if (mapped !== undefined) {
      out += mapped;
    } else if (/[a-z0-9]/.test(ch)) {
      out += ch;
    } else if (ch === "'" || ch === '\u2019') {
      // drop apostrophes entirely
    } else {
      out += '-';
    }
  }
  return out;
}

/** Collapse separators, trim dashes, hard-cap length for URL sanity. */
export function slugifyText(text: string, maxLen = 80): string {
  const collapsed = transliterate(text)
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = collapsed.slice(0, maxLen).replace(/-+$/g, '');
  return trimmed;
}

/**
 * Stable unique slug for an imported entity:
 * `<transliterated-name>-<external-id>`. The numeric suffix guarantees
 * global uniqueness regardless of name changes or transliteration edits.
 */
export function slugWithId(name: string, externalId: string): string {
  const base = slugifyText(name);
  return `${base === '' ? 'item' : base}-${externalId}`;
}
