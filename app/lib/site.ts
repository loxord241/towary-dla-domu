/**
 * Site-wide public constants shared by server and client components.
 * Lives in lib/ (not in a component file) so client islands can import it
 * without pulling a component module into their bundle or creating a
 * SiteFooter ⇄ FeedbackModal import cycle.
 */

/** Public support e-mail shown in the footer (single source for mailto). */
export const CONTACT_EMAIL = 'magazinujut@gmail.com';
