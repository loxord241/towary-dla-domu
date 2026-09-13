/**
 * Wallpaper PDP TITLE cleanup (SEO package 2026-09-13). Pure and
 * dependency-free — node:test loads it without Supabase/Next, same pattern
 * as parse.ts.
 *
 * wc-* names are supplier comma-chains («41704 рожева полоса,шпалери,
 * 53см*10м»), and the PDP title template `${name} — Товари для дому`
 * overflowed 100 characters. Only the <title> is cleaned: the H1 and
 * og:title keep the FULL name (the full product text must stay on the
 * page), so this helper never feeds anything but the head title.
 *
 * Rules:
 *  1. drop the junk tail after the LAST comma when the remainder stays
 *     meaningful (≥ MIN_MEANINGFUL chars) — «…,шпалери,53см*10м» → «…,шпалери»;
 *  2. while still longer than TITLE_CAP, keep dropping trailing
 *     comma-segments while a meaningful remainder remains;
 *  3. hard-cap at TITLE_CAP with an ellipsis (no mid-segment cut while a
 *     comma boundary exists).
 */

/** ~70 chars: the range SERPs actually display before truncation. */
export const TITLE_CAP = 70;

/** A remainder shorter than this is not a meaningful title. */
const MIN_MEANINGFUL = 4;

export function cleanWallpaperTitle(rawName: string): string {
  let title = rawName.trim();
  if (title === '') return title;

  // Rule 1: unconditional single-tail drop (remainder must stay meaningful).
  const tailDrop = (candidate: string): string | null => {
    const lastComma = candidate.lastIndexOf(',');
    if (lastComma === -1) return null;
    const head = candidate.slice(0, lastComma).trim();
    return head.length >= MIN_MEANINGFUL ? head : null;
  };

  const once = tailDrop(title);
  if (once !== null) title = once;

  // Rule 2: length-driven drops, always at comma boundaries.
  while (title.length > TITLE_CAP) {
    const shorter = tailDrop(title);
    if (shorter === null) break;
    title = shorter;
  }

  // Rule 3: no comma boundary left → hard cap with an ellipsis.
  if (title.length > TITLE_CAP) {
    title = `${title.slice(0, TITLE_CAP - 1).trimEnd()}…`;
  }
  return title;
}

/**
 * TITLE decision for one product: wallpapers (wc-* prefix on the sku or the
 * slug — the same gate the PDP uses for the wallpaper domain) get the
 * cleaned chain name, every other product keeps its full name untouched.
 */
export function isWallpaperNaming(sku: string, slug: string): boolean {
  return sku.startsWith('wc-') || slug.startsWith('wc-');
}
