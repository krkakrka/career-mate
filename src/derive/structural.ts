import { extractOgMeta } from '../pages/text.js';
import type { Preferences } from '../config/preferences.js';
import { classifyLocationName, findJobPostingLd, type DeclaredSalary } from './jsonld.js';

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

/**
 * Bump when the deterministic rules feeding `role_research` change.
 *
 * Separate from the structural versions for the same reason those are
 * separate from each other: a change here must not mark every company's
 * research derivation stale and pay to redo it.
 */
export const ROLE_RESEARCH_PREFILL_RULES_VERSION = 2;
export const COMPANY_PREFILL_RULES_VERSION = 1;

export const ROLE_STRUCTURAL_FIELDS = ['title', 'description', 'companyName', 'companyUrl'] as const;
export const COMPANY_STRUCTURAL_FIELDS = ['name', 'description'] as const;

/** The fields `research-web.sh role` can be asked for, in the order it describes them. */
export const ROLE_RESEARCH_FIELDS = ['salaryMin', 'salaryMax', 'equity', 'remoteEu'] as const;

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
  known: Partial<Record<Field, string | number | null>>,
): Field[] {
  return allFields.filter((field) => known[field] == null);
}

/** Everything a posting's own `JobPosting` block settles about the research fields, plus why anything was refused. */
export interface RoleResearchPrefill {
  remoteEu: 'yes' | 'no' | null;
  salaryMin: number | null;
  salaryMax: number | null;
  /** Accompanies the two figures above and is null whenever they are — never a currency without an amount. */
  salaryCurrency: string | null;
  /**
   * Why a declared `baseSalary` was not believed, for the operational log.
   *
   * Deliberately *not* one of the prefill fields: the caller keys the
   * derivation on the fields only, so a posting that restates the same
   * unusable declaration differently does not churn a paid re-research.
   */
  salaryDeclined: string | null;
}

/** Only an annual figure can be compared to an annual floor; `HOUR`/`MONTH`/`WEEK` read as catastrophic salaries. */
const REQUIRED_SALARY_UNIT = 'YEAR';

/**
 * Whether a declared pay range may be written to `roles.salary_*`.
 *
 * Both gates exist because `compFitTerm` compares bare integers and nothing
 * downstream reads the result back to notice it was nonsense:
 *
 * - **Unit.** `unitText` must say `YEAR` outright. An hourly 80 stored as a
 *   salary reads as catastrophic, and a missing `unitText` is silence, not
 *   a year — schema.org does not default it.
 * - **Currency.** It must match the currency you told us `minSalary` is in.
 *   Conversion is not in scope and a rate would be stale the day after it
 *   was written; refusing is the honest option. With `preferences.currency`
 *   unset nothing is ever accepted, which is exactly the behaviour before
 *   this rule existed — the model is still asked.
 *
 * Returns the reason on rejection so the caller can log it: a declaration
 * refused for currency is a one-line config fix, and silently paying for a
 * search instead would never tell you that.
 */
function judgeSalary(
  declared: DeclaredSalary | null,
  currency: string | null,
): { accepted: DeclaredSalary | null; declined: string | null } {
  if (!declared) return { accepted: null, declined: null };
  if (declared.unitText !== REQUIRED_SALARY_UNIT) {
    return { accepted: null, declined: `declared per ${declared.unitText ?? 'an unstated period'}, not ${REQUIRED_SALARY_UNIT}` };
  }
  if (declared.currency === null) return { accepted: null, declined: 'declared no currency' };
  if (currency === null) {
    return { accepted: null, declined: `declared ${declared.currency}; set preferences.currency to accept declared pay` };
  }
  if (declared.currency !== currency) {
    return { accepted: null, declined: `declared ${declared.currency}, but preferences.currency is ${currency}` };
  }
  return { accepted: declared, declined: null };
}

/**
 * What a posting's own `JobPosting` declaration settles for free, from the
 * publisher rather than from a guess: remote/EU eligibility, and the pay.
 *
 * Both feed the priority score directly and neither is read back by
 * anything that could notice a wrong answer, so every rule here refuses
 * rather than estimates. See `judgeSalary` for the pay gates; the location
 * rules follow.
 *
 * Deliberately conservative: this field feeds `remoteEuMatchTerm` in the
 * priority score, so a wrong `no` quietly pushes a good role down the list
 * and a wrong `yes` pulls a bad one up — and unlike a wrong title, nothing
 * downstream reads it back and notices. Every case that is not
 * unambiguous returns `null`, which leaves the question to the model
 * exactly as before.
 *
 * The rules, all requiring `jobLocationType: TELECOMMUTE` — "remote_eu"
 * means remote *and* EU-eligible, so an onsite role in Berlin is not a
 * `yes` however European it is:
 *
 * - TELECOMMUTE + an EU name among the applicant requirements → `yes`
 * - TELECOMMUTE + requirements that are *all recognisably* non-EU → `no`
 * - TELECOMMUTE + any name we cannot classify → `null`. `Worldwide`,
 *   `Anywhere` and `EMEA` are all things publishers write, and none of
 *   them settles EU eligibility; treating an unrecognised name as non-EU
 *   scored a remote-worldwide role *below* an unresearched one, and
 *   permanently, since the model was then never asked.
 * - TELECOMMUTE with no requirements declared → `null` (remote, but from
 *   where is genuinely unstated)
 * - no TELECOMMUTE → `null`, *not* `no`: schema.org only defines the
 *   property for telecommute roles, so its absence is silence rather than
 *   a denial, and plenty of remote postings simply omit it.
 */
export function prefillRoleResearch(html: string, preferences: Preferences): RoleResearchPrefill {
  const posting = findJobPostingLd(html);
  const salary = judgeSalary(posting?.baseSalary ?? null, preferences.currency);
  const base = {
    salaryMin: salary.accepted?.min ?? null,
    salaryMax: salary.accepted?.max ?? null,
    salaryCurrency: salary.accepted?.currency ?? null,
    salaryDeclined: salary.declined,
  };

  if (!posting || posting.jobLocationType?.toUpperCase() !== 'TELECOMMUTE') return { ...base, remoteEu: null };
  if (posting.applicantCountries.length === 0) return { ...base, remoteEu: null };

  const verdicts = posting.applicantCountries.map(classifyLocationName);
  if (verdicts.includes('eu')) return { ...base, remoteEu: 'yes' };
  // Only say no when every name was understood.
  return { ...base, remoteEu: verdicts.every((verdict) => verdict === 'non-eu') ? 'no' : null };
}

/** The prefill reduced to the fields the model can be asked for — the part that belongs in a derivation key. */
export function roleResearchPrefillFields(
  prefill: RoleResearchPrefill,
): Record<(typeof ROLE_RESEARCH_FIELDS)[number], string | number | null> {
  return {
    salaryMin: prefill.salaryMin,
    salaryMax: prefill.salaryMax,
    // No deterministic rule fills equity — a posting never declares it —
    // and listing it here is what keeps `missingFields` asking for it.
    equity: null,
    remoteEu: prefill.remoteEu,
  };
}
