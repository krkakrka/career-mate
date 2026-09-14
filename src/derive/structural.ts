import { extractOgMeta } from '../pages/text.js';
import { findJobPostingLd } from './jsonld.js';

/**
 * Fields the structural extraction can produce for each entity kind. The
 * order is the order they're described to the model.
 */
/**
 * Bump when the deterministic prefill rules below change what they produce.
 *
 * Split per entity kind. A single shared constant meant that adding a role
 * rule also marked every tracked *company* structural derivation stale —
 * ~90 of them here — for a `prefillCompanyStructural` that had not changed
 * by a byte, which is precisely the paid-for-nothing re-extraction the
 * hand-maintained-version approach exists to avoid.
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
export const ROLE_PREFILL_RULES_VERSION = 2;
export const COMPANY_PREFILL_RULES_VERSION = 1;

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
 * Read from schema.org JSON-LD (`JobPosting`) where the board declares one
 * — the publisher stating the fields outright rather than a model inferring
 * them from prose. That is the bar CLAUDE.md sets: more reliable than the
 * model, not merely cheaper. Coverage varies by board and is often partial
 * (Ashby declares all three, Lever omits the company URL, Greenhouse
 * declares nothing); see `jsonld.ts` for what was measured.
 *
 * Deliberately still nothing from `<title>`/`og:title`. Step 16 proposed
 * taking the title from there and review showed the source is unsound: on
 * the ATSes hosting most postings both are boilerplate-wrapped rather than
 * the title ("Job Application for Senior Backend Engineer at Acme" on
 * Greenhouse, "Acme - Senior Backend Engineer" on Lever, "Senior Backend
 * Engineer @ Acme" on Ashby). A page with no JSON-LD still goes to the
 * model, which unwraps those correctly from the derived text.
 *
 * `companyUrl` matters more than it looks: it is what `resolveRoleCompany`
 * keys on, and `hiringOrganization.sameAs` is the company's own declared
 * URL rather than the model's best guess at one.
 *
 * `description` is not prefilled even though JSON-LD has a field by that
 * name — see the note in `jsonld.ts`. The two are different values.
 */
export function prefillRoleStructural(html: string): {
  title: string | null;
  companyName: string | null;
  companyUrl: string | null;
} {
  const posting = findJobPostingLd(html);
  return {
    title: posting?.title ?? null,
    companyName: posting?.companyName ?? null,
    companyUrl: posting?.companyUrl ?? null,
  };
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
