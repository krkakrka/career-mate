import { extractOgMeta } from '../pages/text.js';

/**
 * Fields the structural extraction can produce for each entity kind. The
 * order is the order they're described to the model.
 */
/**
 * Bump when the deterministic prefill rules below change what they produce.
 *
 * These rules are half the structural recipe (the free pass that runs before
 * the model), so a change to them must invalidate the values they produced —
 * otherwise adding, say, the JSON-LD `JobPosting.title` rule from the Backlog
 * would apply only to entities added afterwards, silently leaving every
 * existing role on the old behaviour.
 *
 * Hand-maintained rather than a hash of this file: a file hash would also
 * fire on a comment or an unrelated refactor, and re-extracting every tracked
 * entity costs real money. The version is the claim "the rules changed".
 */
export const PREFILL_RULES_VERSION = 1;

export const ROLE_STRUCTURAL_FIELDS = ['title', 'description', 'companyName', 'companyUrl'] as const;
export const COMPANY_STRUCTURAL_FIELDS = ['name', 'description'] as const;

export type RoleStructuralField = (typeof ROLE_STRUCTURAL_FIELDS)[number];
export type CompanyStructuralField = (typeof COMPANY_STRUCTURAL_FIELDS)[number];

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** First value for an Open Graph property, in document order. */
function og(html: string, property: string): string | undefined {
  return extractOgMeta(html).find((meta) => meta.property === property)?.content;
}

/**
 * What a role page's own metadata already tells us, for free.
 *
 * Deliberately nothing — including `title`, which the original plan for
 * this step proposed taking from `<title>`/`og:title`. On the ATSes that
 * host most postings, both are boilerplate-wrapped rather than the title:
 * Greenhouse serves "Job Application for Senior Backend Engineer at Acme",
 * Lever "Acme - Senior Backend Engineer", Ashby "Senior Backend Engineer @
 * Acme". Writing those into `roles.title` would pollute the notification
 * label and the role-research prompt context, and it buys nothing: the
 * same values are already in the header block of the text the model reads,
 * and the model unwraps them correctly. A deterministic rule is only worth
 * having where it is *more* reliable than the model, not merely cheaper.
 *
 * The function stays as the place a sound rule would go — JSON-LD
 * `JobPosting.title` is the obvious candidate and is in the Backlog.
 */
export function prefillRoleStructural(_html: string): { title: string | null } {
  return { title: null };
}

/**
 * What a company page's own metadata already tells us.
 *
 * `og:site_name` and nothing else: it is an unambiguous declaration of
 * what the site calls itself, which is the one case here where the markup
 * is more reliable than a model reading the page. There is deliberately no
 * `<title>` fallback — a company homepage's title is typically a marketing
 * tagline ("Payments infrastructure for the internet"), not a name.
 */
export function prefillCompanyStructural(html: string): { name: string | null } {
  return { name: clean(og(html, 'og:site_name')) };
}

/** The fields still worth asking the model for — everything the deterministic pass could not fill. */
export function missingFields<Field extends string>(
  allFields: readonly Field[],
  known: Partial<Record<Field, string | null>>,
): Field[] {
  return allFields.filter((field) => known[field] == null);
}
