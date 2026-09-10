/**
 * Deterministic HTML → text derivation. Pure, in-process, free — this is
 * the "cheap rule" that runs before any model call: extraction scripts read
 * the derived text, never the raw HTML, which cuts input size by roughly an
 * order of magnitude on a real job posting.
 *
 * The output is a stable function of the input (no dates, no randomness, no
 * environment) because it is hashed: `page_snapshots.text_hash` is what
 * later steps compare against a derivation's recorded source key to decide
 * staleness. Changing anything here changes every text hash, so treat it
 * as a versioned format, not an incidental helper.
 */

/**
 * The entities that actually show up in job postings and company pages.
 * Deliberately not the full HTML5 named-entity table (~2000 entries) — an
 * unrecognized entity is left as-is, which is readable rather than wrong.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // A non-breaking space becomes an ordinary one so whitespace collapsing
  // below can actually collapse it; keeping U+00A0 would leave ragged runs
  // of "invisible" characters in the text the model reads.
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  laquo: '«',
  raquo: '»',
  times: '×',
  eacute: 'é',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (!body.startsWith('#')) return NAMED_ENTITIES[body.toLowerCase()] ?? match;

    const isHex = body[1] === 'x' || body[1] === 'X';
    const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
    // Reject lone surrogates as well as out-of-range values: they survive
    // in a JS string but are replaced with U+FFFD when the text is written
    // to disk as UTF-8, which would make the file's bytes differ from the
    // string we hashed.
    if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return match;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
    return String.fromCodePoint(codePoint);
  });
}

/**
 * Reads one attribute out of a single tag's source. `name` is always a
 * literal from this module (never user input), so it needs no escaping.
 *
 * The name is anchored with a negative lookbehind rather than `\b`: `\b`
 * matches after a hyphen, so `data-content="tracking-id"` would satisfy a
 * search for `content` and win by appearing first in the tag — putting a
 * tracking id where the header block promises an og value.
 */
function readAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?<![\\w-])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (!match) return undefined;
  return match[2] ?? match[3] ?? match[4];
}

/** Flattens a fragment that may contain markup/entities/newlines to one clean line. */
function toSingleLine(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return undefined;
  const title = toSingleLine(match[1] ?? '');
  return title.length > 0 ? title : undefined;
}

/**
 * Open Graph metadata in document order. Kept as a list rather than a map
 * because a page may legitimately repeat a property (several `og:image`),
 * and document order is what makes the derived text deterministic.
 */
export function extractOgMeta(html: string): Array<{ property: string; content: string }> {
  const found: Array<{ property: string; content: string }> = [];

  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    // Spec says `property`, but plenty of real pages emit `name="og:..."`.
    const property = readAttribute(tag, 'property') ?? readAttribute(tag, 'name');
    if (!property || !property.toLowerCase().startsWith('og:')) continue;

    const rawContent = readAttribute(tag, 'content');
    if (rawContent === undefined) continue;

    const content = toSingleLine(rawContent);
    if (content.length > 0) found.push({ property: property.toLowerCase(), content });
  }

  return found;
}

/**
 * The canonical URL a page declares for itself. Worth a header line: on an
 * ATS-hosted posting it is often the only place the real posting URL
 * appears, and it costs one regex rather than a model call.
 */
export function extractCanonicalUrl(html: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (readAttribute(tag, 'rel')?.toLowerCase() !== 'canonical') continue;
    const href = toSingleLine(readAttribute(tag, 'href') ?? '');
    if (href) return href;
  }
  return undefined;
}

/** Tags whose boundaries are a line break in the derived text. */
const BLOCK_TAGS =
  'p|div|section|article|header|footer|nav|aside|main|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|h[1-6]|form|fieldset|legend|label|blockquote|pre|figure|figcaption|address|option';

/** Tags whose *contents* are noise, not text — dropped wholesale. */
const NOISE_TAGS = 'script|style|noscript|template|svg|iframe|canvas';

/**
 * Rewrites `<a href="https://…">Text</a>` as `Text (https://…)`, the
 * convention every text browser uses.
 *
 * Without this, the final tag strip would discard every attribute and take
 * all links with it — and `extract-structural.sh` asks the model for a
 * role's `companyUrl` "from the page content or links", which
 * `resolveRoleCompany` then uses to attach the role to a company. On a
 * typical Greenhouse/Lever posting the employer's own domain appears
 * *only* as a logo link, never as visible text, so dropping hrefs would
 * silently turn company resolution into `role.company_unresolved`.
 *
 * Only absolute http(s) hrefs are kept: a relative or `javascript:` href
 * tells the model nothing and is pure noise.
 */
function inlineAnchorHrefs(html: string): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (match, attributes: string, inner: string) => {
    const href = readAttribute(`<a ${attributes}>`, 'href');
    if (!href || !/^https?:\/\//i.test(href.trim())) return match;

    const text = toSingleLine(inner);
    const url = toSingleLine(href);
    // A bare link (the anchor text *is* the URL) needs no parenthetical.
    if (!text || text === url) return ` ${url} `;
    return `${inner} (${url})`;
  });
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Derives the text form of a page: a `key: value` header block carrying
 * `<title>` and any Open Graph metadata (the most reliably structured facts
 * on a job posting, and the ones a later step pre-fills from without asking
 * the model), a blank line, then the page's visible text.
 */
export function deriveText(html: string): string {
  const header: string[] = [];
  const title = extractTitle(html);
  if (title) header.push(`title: ${title}`);
  const canonical = extractCanonicalUrl(html);
  if (canonical) header.push(`canonical: ${canonical}`);
  for (const { property, content } of extractOgMeta(html)) header.push(`${property}: ${content}`);

  const body = normalizeWhitespace(
    decodeHtmlEntities(
      inlineAnchorHrefs(html.replace(/<!--[\s\S]*?-->/g, ' '))
        .replace(new RegExp(`<(${NOISE_TAGS})\\b[^>]*>[\\s\\S]*?</\\1>`, 'gi'), ' ')
        // <head> is stripped after title/og extraction above: everything in
        // it that carries text is already in the header block, and what's
        // left (link/meta/base) contributes nothing but noise.
        .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
        // Source whitespace collapses to spaces *before* any line break is
        // introduced: a newline in the markup is only pretty-printing, so a
        // <p> wrapped across three source lines is still one line of text.
        // Every line break in the output comes from a tag, below.
        .replace(/\s+/g, ' ')
        .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
        .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
        .replace(/<[^>]*>/g, ' '),
    ),
  );

  if (header.length === 0) return body;
  return body.length === 0 ? header.join('\n') : `${header.join('\n')}\n\n${body}`;
}
