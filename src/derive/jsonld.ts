/**
 * schema.org `JobPosting`, read from a page's own JSON-LD.
 *
 * This is the sound source for a role title that Step 16 went looking for
 * and didn't find. `<title>`/`og:title` are boilerplate-wrapped on every
 * major ATS ("Job Application for X at Acme"), which is why that rule was
 * dropped; JSON-LD is the publisher declaring the fields outright. It
 * clears the bar CLAUDE.md sets for a deterministic rule: more reliable
 * than a model reading the page, not merely cheaper.
 *
 * Coverage, measured against live postings on 2026-09-14 rather than
 * assumed — the three boards behave differently and the difference is the
 * point:
 *
 *   Ashby       full JobPosting; title, hiringOrganization.name and
 *               hiringOrganization.sameAs all present.
 *   Lever       JobPosting with title and name, but no `sameAs`, so
 *               companyUrl still goes to the model.
 *   Greenhouse  no ld+json on a job page at all. Nothing is prefilled and
 *               the behaviour is exactly what it was before this rule.
 *
 * Partial coverage is the normal case, not a defect: `missingFields` asks
 * the model for whatever the declaration omitted.
 *
 * `description` is deliberately NOT read here. The extraction prompt asks
 * for "a concise 2-4 sentence summary of the role"; JSON-LD's `description`
 * is the entire posting as an HTML string. They share a name and are not
 * the same value, and prefilling one with the other would put tens of
 * kilobytes of markup into `roles.description` and into the role-research
 * prompt's context.
 */

import { isHttpUrl } from '../lib/is-http-url.js';

/**
 * Matches a JSON-LD script block. Built per call rather than shared: a
 * module-level /g regex carries `lastIndex` between calls, so every second
 * call would start scanning from where the last one stopped and miss.
 *
 * The attribute is matched as `\stype`, not `\btype`: `-` is a non-word
 * character, so `\b` also holds inside `data-type`, and a template block
 * (`<script data-type="application/ld+json" type="text/template">`) would
 * be read as though the page had declared it.
 */
const SCRIPT_PATTERN = String.raw`<script\b[^>]*\stype\s*=\s*["']application/ld\+json["'][^>]*>([\s\S]*?)</script>`;

/**
 * Hosts that are never a company's own homepage, so a URL on one is worse
 * than no URL at all: `findOrCreateCompanyByUrl` keys the company on
 * whatever it is given, and `resolveRoleCompany` then enqueues a fetch of
 * it for a description.
 *
 * The ATS entries mirror the guard already written into
 * `extract-structural.sh`'s `companyUrl` prompt; the social ones exist
 * because schema.org defines `sameAs` as a *reference page identifying the
 * item* — a LinkedIn or Wikipedia page is a conforming value for it. When
 * this rejects a candidate the field stays null and the model is asked,
 * which is the outcome we want: the prompt has the same guard and more
 * context to apply it with.
 */
const NOT_A_COMPANY_SITE = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'workday.com',
  'workable.com',
  'bamboohr.com',
  'smartrecruiters.com',
  'linkedin.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'crunchbase.com',
  'wikipedia.org',
  'glassdoor.com',
];

function isCompanySite(value: string): boolean {
  if (!isHttpUrl(value)) return false;
  const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  return !NOT_A_COMPANY_SITE.some((bad) => host === bad || host.endsWith(`.${bad}`));
}

export interface JobPostingLd {
  title: string | null;
  companyName: string | null;
  companyUrl: string | null;
  /** `"TELECOMMUTE"` is the only value schema.org defines; anything else (or absence) means the publisher said nothing. */
  jobLocationType: string | null;
  /** Country names from `applicantLocationRequirements` — where a remote applicant may actually be. */
  applicantCountries: string[];
  /** `baseSalary`, as declared. Null when absent or when no pair of figures could be read from it. */
  baseSalary: DeclaredSalary | null;
}

/**
 * A `MonetaryAmount` the publisher attached to the posting, read but not
 * yet judged.
 *
 * `unitText` and `currency` are carried through rather than filtered here
 * on purpose: this module reports what the page said, and whether an
 * hourly rate in yen is usable is a question about *your* configuration,
 * which `prefillRoleResearch` owns. Keeping the rejection there is also
 * what lets it say why.
 */
export interface DeclaredSalary {
  /** Uppercased ISO code as declared, e.g. `USD`. Never blank. */
  currency: string | null;
  /** Uppercased, e.g. `YEAR`, `MONTH`, `HOUR`. Null when the publisher omitted it — which is silence, not a year. */
  unitText: string | null;
  min: number;
  max: number;
}

/**
 * The EU, by the names publishers actually write.
 *
 * Measured against live Ashby postings: one declares
 * `{"@type":"Country","name":"European Union"}` outright, another lists
 * member states individually. Both have to resolve to the same answer.
 *
 * "Europe" is deliberately absent — it includes the UK, Switzerland and
 * Norway, so it cannot settle *EU* eligibility, and guessing wrong here
 * removes a good role from consideration via the priority score.
 */
const EU_NAMES = new Set(
  [
    'european union', 'eu', 'eea', 'european economic area',
    'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czechia', 'czech republic',
    'denmark', 'estonia', 'finland', 'france', 'germany', 'greece', 'hungary', 'ireland',
    'italy', 'latvia', 'lithuania', 'luxembourg', 'malta', 'netherlands', 'the netherlands',
    'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden',
  ].map((name) => name.toLowerCase()),
);

/**
 * Names that are definitely *not* the EU.
 *
 * Needed to say "no" honestly. Without it, any name the EU list did not
 * recognise counted as non-EU — so `Worldwide`, `Anywhere`, `EMEA` and
 * `Deutschland` all produced a confident `no`, and a remote-worldwide
 * posting (which is EU-eligible) scored *below* an unresearched one,
 * permanently, because the model was never asked to correct it.
 */
const NON_EU_NAMES = new Set(
  [
    'united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.',
    'canada', 'united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales',
    'australia', 'new zealand', 'india', 'singapore', 'japan', 'china', 'hong kong',
    'brazil', 'mexico', 'argentina', 'chile', 'colombia', 'south africa', 'nigeria', 'kenya',
    'israel', 'turkey', 'ukraine', 'switzerland', 'norway', 'iceland', 'serbia',
    'united arab emirates', 'uae', 'philippines', 'indonesia', 'vietnam', 'thailand',
    'south korea', 'korea', 'taiwan', 'pakistan', 'bangladesh', 'egypt', 'morocco',
  ].map((name) => name.toLowerCase()),
);

export type EuVerdict = 'eu' | 'non-eu' | 'unrecognized';

/**
 * Classifies one declared location name.
 *
 * `unrecognized` is a real answer, not a failure: `Worldwide`, `EMEA` and
 * `Remote` are all things publishers actually write, and none of them
 * settles EU eligibility.
 */
export function classifyLocationName(name: string): EuVerdict {
  const normalized = name.trim().toLowerCase();
  if (EU_NAMES.has(normalized)) return 'eu';
  if (NON_EU_NAMES.has(normalized)) return 'non-eu';
  return 'unrecognized';
}

/** Country names out of `applicantLocationRequirements`, which may be one object, an array, or a bare string. */
function applicantCountries(value: unknown): string[] {
  const names: string[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry === 'string') {
      const name = clean(entry);
      if (name) names.push(name);
      continue;
    }
    if (!isRecord(entry)) continue;
    const name = clean(entry.name);
    if (name) names.push(name);
  }
  return names;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJobPosting(node: unknown): node is Record<string, unknown> {
  if (!isRecord(node)) return false;
  const type = node['@type'];
  if (typeof type === 'string') return type === 'JobPosting';
  return Array.isArray(type) && type.includes('JobPosting');
}

/** Every object reachable in a JSON-LD document: bare, in an array, or under `@graph`. */
function* nodes(value: unknown): Generator<unknown> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodes(item);
    return;
  }
  if (!isRecord(value)) return;
  yield value;
  if (value['@graph'] !== undefined) yield* nodes(value['@graph']);
}

/**
 * The company behind the posting.
 *
 * `hiringOrganization` is an Organization, sometimes wrapped in an array,
 * sometimes just a name. For the URL, `url` is schema.org's property for
 * *the item's own website* and is preferred; `sameAs` is only a reference
 * page that identifies the item, so it is the fallback and frequently an
 * array of social profiles.
 *
 * A candidate that isn't an http(s) URL on a plausible company host comes
 * back as `null` — deliberately, and this is load-bearing rather than
 * tidiness. `missingFields` treats any non-null prefill as "answered", so
 * returning an unusable string here would drop `companyUrl` from the
 * model's field list, fail `isHttpUrl` in `resolveRoleCompany`, and leave
 * the role permanently unresolved: the derivation is written in the same
 * transaction, so the retry skips, and `--force` re-derives the same bad
 * value. Null means the model is still asked, which is what it did before
 * this rule existed.
 */
function organization(value: unknown): { name: string | null; url: string | null } {
  const node = Array.isArray(value) ? value[0] : value;
  if (typeof node === 'string') return { name: clean(node), url: null };
  if (!isRecord(node)) return { name: null, url: null };

  const candidates = [node.url, ...(Array.isArray(node.sameAs) ? node.sameAs : [node.sameAs])];
  const url = candidates.map(clean).find((candidate) => candidate !== null && isCompanySite(candidate)) ?? null;

  return { name: clean(node.name), url };
}

/**
 * A finite, positive number, or null.
 *
 * Rejects `0`, `-1`, `NaN` — and numeric *strings*, deliberately. No live
 * posting measured here writes one, and the moment you start parsing them
 * you have to decide what `"211,400"` and `"$211,400"` mean. A rejected
 * value costs one model call; a misparsed one is written straight into the
 * priority score.
 */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function upper(value: unknown): string | null {
  const text = clean(value);
  return text === null ? null : text.toUpperCase();
}

/**
 * The declared pay, from `baseSalary`.
 *
 * Measured against live postings on 2026-09-14, and the shapes genuinely
 * differ: Ashby/ramp declares
 * `{"@type":"MonetaryAmount","currency":"USD","value":{"minValue":211400,"maxValue":290600,"unitText":"YEAR"}}`,
 * while cohere and linear declare nothing at all — `baseSalary` tracks US
 * pay-transparency law, so coverage is patchy and location-dependent.
 *
 * Three shapes are accepted for `value`, all of which schema.org allows:
 * a `QuantitativeValue` with `minValue`/`maxValue`, one with a single
 * `value` (an exact figure, read as min = max), or a bare number.
 *
 * A range is returned all-or-nothing. A declaration giving only a
 * `minValue` comes back null rather than half-filled, because the consumer
 * writes `salary_min`, `salary_max` and `salary_currency` as one unit: a
 * declared EUR minimum next to a model-researched maximum would be stamped
 * with a currency that describes only one of them, and `compFitTerm` reads
 * the maximum.
 *
 * `unitText` is read from the `value` first and the amount second — the
 * former is where schema.org's own examples put it, the latter is where
 * some publishers put it anyway.
 */
function baseSalary(value: unknown): DeclaredSalary | null {
  const node = Array.isArray(value) ? value[0] : value;
  if (!isRecord(node)) return null;

  const amount = isRecord(node.value) ? node.value : null;
  const bare = positiveNumber(node.value);

  let min: number | null;
  let max: number | null;
  if (amount) {
    const exact = positiveNumber(amount.value);
    min = positiveNumber(amount.minValue) ?? exact;
    max = positiveNumber(amount.maxValue) ?? exact;
  } else {
    min = bare;
    max = bare;
  }
  if (min === null || max === null) return null;
  // A publisher that swapped them still declared a range; ordering it here
  // keeps every consumer from having to.
  if (min > max) [min, max] = [max, min];

  return {
    // `currency` only. `currencyCode` is not a schema.org property of
    // MonetaryAmount, and an unmeasured fallback does not earn its place
    // here — a declaration we cannot read costs one model call, which is
    // what would have happened anyway.
    currency: upper(node.currency),
    unitText: (amount ? upper(amount.unitText) : null) ?? upper(node.unitText),
    min,
    max,
  };
}

/**
 * The first `JobPosting` declared on the page, or `null`.
 *
 * Never throws. A malformed block is skipped and scanning continues — a
 * truncated or hand-edited one must not take down the enrichment handler,
 * since the whole value of this pass is that it is free and optional.
 *
 * The script's contents are parsed as-is. Script content is raw text in
 * HTML, so a conforming producer already writes a literal `&`; running the
 * block through an entity decoder would corrupt the `&amp;` sequences that
 * are genuinely part of the embedded HTML in `description`.
 */
export function findJobPostingLd(html: string): JobPostingLd | null {
  const pattern = new RegExp(SCRIPT_PATTERN, 'gi');

  for (const match of html.matchAll(pattern)) {
    const body = match[1];
    if (body === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }

    for (const node of nodes(parsed)) {
      if (!isJobPosting(node)) continue;
      const org = organization(node.hiringOrganization);
      return {
        title: clean(node.title),
        companyName: org.name,
        companyUrl: org.url,
        jobLocationType: clean(node.jobLocationType),
        applicantCountries: applicantCountries(node.applicantLocationRequirements),
        baseSalary: baseSalary(node.baseSalary),
      };
    }
  }

  return null;
}
