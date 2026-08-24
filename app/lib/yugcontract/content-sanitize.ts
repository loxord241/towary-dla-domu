import sanitizeHtml from 'sanitize-html';

/**
 * Allowlist sanitizer for Yugcontract supplier descriptions.
 *
 * The dry-run (2026-08-24) measured the real feed: 99.99% of non-empty
 * descriptions are HTML; observed dangerous constructs were iframe=1,
 * style attrs/tags=336 and ZERO script tags, inline event handlers,
 * javascript: or data: URLs — but the allowlist below does NOT trust
 * those zeros: everything not explicitly allowed is removed, and removal
 * happens server-side BEFORE anything is persisted (staging stores
 * sanitized text only).
 *
 * Rationale for the allowlist (typical supplier marketing markup):
 * structure (p/br/hr/h3/h4), lists (ul/ol/li), emphasis (strong/b/em/i/u),
 * product tables (table/thead/tbody/tr/th/td), inline containers
 * (span/div) and images (img with http(s) src only). All attributes are
 * stripped except img src/alt; style/class/id never survive.
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'span',
  'div',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'img',
];

export function sanitizeYcDescription(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      img: ['src', 'alt'],
    },
    allowedSchemes: ['http', 'https'],
    // protocol-relative "//evil.com" inherits the page scheme but is a
    // cross-origin surprise; supplier content has no need for it.
    allowProtocolRelative: false,
    // script/style contents are dropped entirely (default nonTextTags),
    // other disallowed tags are discarded while their text survives.
    disallowedTagsMode: 'discard',
  }).trim();
}
