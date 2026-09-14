import { describe, expect, it } from 'vitest';
import type { Preferences } from '../config/preferences.js';
import {
  COMPANY_STRUCTURAL_FIELDS,
  prefillRoleResearch,
  ROLE_RESEARCH_FIELDS,
  missingFields,
  prefillCompanyStructural,
  prefillRoleStructural,
  roleResearchPrefillFields,
  ROLE_STRUCTURAL_FIELDS,
} from './structural.js';

const jobPostingLd = (fields: Record<string, unknown>) =>
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', ...fields })}</script>`;

describe('prefillRoleStructural', () => {
  it.each([
    ['Greenhouse', 'Job Application for Senior Backend Engineer at Acme'],
    ['Lever', 'Acme - Senior Backend Engineer'],
    ['Ashby', 'Senior Backend Engineer @ Acme'],
  ])('does not take a role title from %s boilerplate in <title>/og:title', (_ats, pageTitle) => {
    // Both elements carry the ATS's wrapper, not the job title. Writing
    // that into roles.title would pollute the notification label and the
    // role-research prompt context — and buy nothing, since the model sees
    // the same values in the derived text's header block and unwraps them.
    const html = `<html><head><title>${pageTitle}</title><meta property="og:title" content="${pageTitle}"></head><body>Join us</body></html>`;
    expect(prefillRoleStructural(html)).toEqual({ title: null, companyName: null, companyUrl: null });
  });

  it('leaves everything to the model on a page with no JSON-LD', () => {
    expect(prefillRoleStructural('<body><p>Join us</p></body>')).toEqual({
      title: null,
      companyName: null,
      companyUrl: null,
    });
  });

  it('takes the title and hiring organisation from a JobPosting declaration', () => {
    const html = `<html><head>${jobPostingLd({
      title: 'Senior Backend Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Acme', sameAs: 'https://acme.com/' },
    })}</head><body>Join us</body></html>`;

    expect(prefillRoleStructural(html)).toEqual({
      title: 'Senior Backend Engineer',
      companyName: 'Acme',
      companyUrl: 'https://acme.com/',
    });
  });

  it('prefers the declaration over ATS boilerplate on the same page', () => {
    const html = `<html><head><title>Job Application for Senior Backend Engineer at Acme</title>${jobPostingLd({
      title: 'Senior Backend Engineer',
    })}</head><body>x</body></html>`;
    expect(prefillRoleStructural(html).title).toBe('Senior Backend Engineer');
  });

  it('does not prefill description, which JSON-LD defines differently', () => {
    // JSON-LD's `description` is the whole posting as HTML; the extraction
    // prompt asks for a concise 2-4 sentence summary. Same name, different
    // value — prefilling one with the other puts tens of kilobytes of
    // markup into roles.description and the research prompt's context.
    const html = jobPostingLd({
      title: 'Senior Backend Engineer',
      description: '<p>'.repeat(500),
      hiringOrganization: { name: 'Acme', sameAs: 'https://acme.com/' },
    });
    expect(prefillRoleStructural(html)).not.toHaveProperty('description');
    // Everything else is filled, so description is the only field left for
    // the model — the point being that it is still asked for, not inherited.
    expect(missingFields(ROLE_STRUCTURAL_FIELDS, prefillRoleStructural(html))).toEqual(['description']);
  });

  it('still asks the model for whatever the declaration omitted', () => {
    const html = jobPostingLd({ title: 'Senior Backend Engineer' });
    expect(missingFields(ROLE_STRUCTURAL_FIELDS, prefillRoleStructural(html))).toEqual([
      'description',
      'companyName',
      'companyUrl',
    ]);
  });
});

describe('prefillCompanyStructural', () => {
  it('uses og:site_name', () => {
    const html = '<html><head><meta property="og:site_name" content="Example Co"></head><body>We do things</body></html>';
    expect(prefillCompanyStructural(html)).toEqual({ name: 'Example Co' });
  });

  it('does not fall back to <title>, which on a homepage is a tagline, not a name', () => {
    const html = '<html><head><title>Payments infrastructure for the internet</title></head><body>x</body></html>';
    expect(prefillCompanyStructural(html)).toEqual({ name: null });
  });
});

describe('missingFields', () => {
  it('asks the model only for what the deterministic pass could not fill', () => {
    expect(missingFields(ROLE_STRUCTURAL_FIELDS, { title: 'Staff Engineer' })).toEqual([
      'description',
      'companyName',
      'companyUrl',
    ]);
    expect(missingFields(ROLE_STRUCTURAL_FIELDS, { title: null })).toEqual([...ROLE_STRUCTURAL_FIELDS]);
    expect(missingFields(COMPANY_STRUCTURAL_FIELDS, { name: 'Example Co' })).toEqual(['description']);
  });
});

describe('prefillRoleResearch', () => {
  const posting = (fields: Record<string, unknown>): string =>
    `<html><body><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: 'Engineer',
      ...fields,
    })}</script></body></html>`;

  const preferences = (currency: string | null = null): Preferences => ({
    titleKeywords: [],
    seniority: null,
    remoteEuRequired: false,
    minSalary: null,
    currency,
  });

  const prefill = (html: string, currency: string | null = null) => prefillRoleResearch(html, preferences(currency));

  // The three shapes measured on live Ashby postings, which differ from
  // each other — a declaration can be one object, a list, or absent.
  it('reads an outright "European Union" declaration', () => {
    const html = posting({
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: { '@type': 'Country', name: 'European Union' },
    });
    expect(prefill(html).remoteEu).toBe('yes');
  });

  it('reads a member state out of a list of countries', () => {
    const html = posting({
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [
        { '@type': 'Country', name: 'United States' },
        { '@type': 'Country', name: 'France' },
        { '@type': 'Country', name: 'Canada' },
      ],
    });
    expect(prefill(html).remoteEu).toBe('yes');
  });

  it('answers no when a remote role is explicitly restricted to non-EU countries', () => {
    const html = posting({
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [{ name: 'Canada' }, { name: 'United States' }],
    });
    expect(prefill(html).remoteEu).toBe('no');
  });

  it('leaves it to the model when a remote role does not say where from', () => {
    // Remote, but from where is genuinely unstated — guessing either way
    // moves the role in the priority score for no reason.
    expect(prefill(posting({ jobLocationType: 'TELECOMMUTE' })).remoteEu).toBe(null);
  });

  it('treats a missing jobLocationType as silence, not as a denial', () => {
    // schema.org only defines the property for telecommute roles, so its
    // absence says nothing — and plenty of remote postings omit it.
    const html = posting({ jobLocation: { '@type': 'Place', address: { addressCountry: 'Germany' } } });
    expect(prefill(html).remoteEu).toBe(null);
  });

  it.each([['Europe'], ['Worldwide'], ['Anywhere'], ['EMEA'], ['Deutschland'], ['Remote']])(
    'leaves %s to the model rather than calling it non-EU',
    (name) => {
      // These are all things publishers actually write, and none settles EU
      // eligibility. Treating an unrecognised name as non-EU scored a
      // remote-worldwide role — which *is* EU-eligible — below an
      // unresearched one, and permanently, since the model was never asked.
      const html = posting({ jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: [{ name }] });
      expect(prefill(html).remoteEu).toBe(null);
    },
  );

  it('will not answer no when one name in the list is unrecognised', () => {
    const html = posting({
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [{ name: 'United States' }, { name: 'Freedonia' }],
    });
    expect(prefill(html).remoteEu).toBe(null);
  });

  it('says nothing about a page with no declaration at all', () => {
    expect(prefill('<html><body><p>Remote, EU welcome</p></body></html>').remoteEu).toBe(null);
  });

  // --- baseSalary --------------------------------------------------------
  //
  // The shape measured on a live Ashby/ramp posting on 2026-09-14. Two
  // things make this field dangerous rather than merely optional: the
  // columns it feeds are bare integers with no currency, and `unitText` is
  // not always YEAR.

  const withSalary = (baseSalary: unknown) => posting({ baseSalary });

  const ramp = {
    '@type': 'MonetaryAmount',
    currency: 'USD',
    value: { '@type': 'QuantitativeValue', minValue: 211400, maxValue: 290600, unitText: 'YEAR' },
  };

  it('reads an annual range declared in the currency your floor is in', () => {
    expect(prefill(withSalary(ramp), 'USD')).toMatchObject({
      salaryMin: 211400,
      salaryMax: 290600,
      salaryCurrency: 'USD',
      salaryDeclined: null,
    });
  });

  it('drops both figures from the model call once they are declared', () => {
    expect(missingFields(ROLE_RESEARCH_FIELDS, roleResearchPrefillFields(prefill(withSalary(ramp), 'USD')))).toEqual([
      'equity',
      'remoteEu',
    ]);
  });

  it('refuses a declaration in another currency and says which', () => {
    // These are compared as bare integers, so ¥5,000,000 clears a €100,000
    // floor by a factor of fifty while being about a third of it. No
    // conversion happens here — the model is asked instead.
    const jpy = { '@type': 'MonetaryAmount', currency: 'JPY', value: { minValue: 5_000_000, maxValue: 8_000_000, unitText: 'YEAR' } };
    const result = prefill(withSalary(jpy), 'EUR');
    expect(result.salaryMin).toBeNull();
    expect(result.salaryMax).toBeNull();
    expect(result.salaryCurrency).toBeNull();
    expect(result.salaryDeclined).toBe('declared JPY, but preferences.currency is EUR');
  });

  it('refuses every declaration until preferences.currency is set, and says so', () => {
    // The default. Unset means "we do not know what minSalary is
    // denominated in", and believing a figure then is a coin flip.
    expect(prefill(withSalary(ramp)).salaryDeclined).toBe(
      'declared USD; set preferences.currency to accept declared pay',
    );
    expect(prefill(withSalary(ramp)).salaryMin).toBeNull();
  });

  it.each([['HOUR'], ['MONTH'], ['WEEK'], ['DAY']])('refuses a rate declared per %s', (unitText) => {
    // An hourly 80 written into salary_max reads as a catastrophic salary,
    // and nothing downstream reads it back to notice.
    const html = withSalary({ '@type': 'MonetaryAmount', currency: 'USD', value: { value: 80, unitText } });
    expect(prefill(html, 'USD').salaryMin).toBeNull();
    expect(prefill(html, 'USD').salaryDeclined).toBe(`declared per ${unitText}, not YEAR`);
  });

  it('treats a missing unitText as silence rather than as a year', () => {
    // schema.org does not default it, and the difference between an annual
    // and a monthly 9000 is the whole question.
    const html = withSalary({ '@type': 'MonetaryAmount', currency: 'EUR', value: { minValue: 9000, maxValue: 11000 } });
    expect(prefill(html, 'EUR').salaryMin).toBeNull();
    expect(prefill(html, 'EUR').salaryDeclined).toBe('declared per an unstated period, not YEAR');
  });

  it('reads a single exact figure as both ends of the range', () => {
    const html = withSalary({ '@type': 'MonetaryAmount', currency: 'EUR', value: { value: 120000, unitText: 'YEAR' } });
    expect(prefill(html, 'EUR')).toMatchObject({ salaryMin: 120000, salaryMax: 120000, salaryCurrency: 'EUR' });
  });

  it('refuses a half-declared range rather than mixing sources', () => {
    // A declared EUR minimum beside a model-researched maximum would be
    // stamped with a currency describing only one of them — and
    // `compFitTerm` reads the maximum.
    const html = withSalary({ '@type': 'MonetaryAmount', currency: 'EUR', value: { minValue: 90000, unitText: 'YEAR' } });
    expect(prefill(html, 'EUR')).toMatchObject({ salaryMin: null, salaryMax: null, salaryDeclined: null });
  });

  it('says nothing at all about a posting that declares no pay', () => {
    expect(prefill(posting({ jobLocationType: 'TELECOMMUTE' }), 'EUR')).toMatchObject({
      salaryMin: null,
      salaryCurrency: null,
      salaryDeclined: null,
    });
  });

  it('matches a lower-cased declaration against an upper-cased preference', () => {
    const html = withSalary({ '@type': 'MonetaryAmount', currency: 'eur', value: { minValue: 90000, maxValue: 110000, unitText: 'year' } });
    expect(prefill(html, 'EUR')).toMatchObject({ salaryMin: 90000, salaryMax: 110000, salaryCurrency: 'EUR' });
  });

  it('keeps salaryDeclined out of the fields the derivation is keyed on', () => {
    // Otherwise a posting restating the same unusable declaration
    // differently would look like new input and buy a paid re-research.
    expect(Object.keys(roleResearchPrefillFields(prefill(withSalary(ramp), 'EUR')))).toEqual([...ROLE_RESEARCH_FIELDS]);
  });

  it('leaves every other research field to the model', () => {
    const html = posting({
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: { name: 'European Union' },
    });
    // Compensation is not declared here, so the call still happens — this
    // step buys accuracy on one field, not a free research pass.
    expect(missingFields(ROLE_RESEARCH_FIELDS, roleResearchPrefillFields(prefill(html)))).toEqual([
      'salaryMin',
      'salaryMax',
      'equity',
    ]);
  });
});
