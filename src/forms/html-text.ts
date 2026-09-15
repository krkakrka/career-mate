/**
 * Readable plain text from the snippets of HTML both board APIs return in
 * their help text.
 *
 * Shared rather than duplicated because only one of the two had it, and the
 * one that did not printed literal `<p>` tags at the user — which the
 * captured Greenhouse fixture contains and no test noticed.
 *
 * Deliberately not a sanitiser: the output goes to a terminal, never to a
 * browser, so this only has to be legible.
 */
export function plainText(html: unknown): string | null {
  if (typeof html !== 'string') return null;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}
