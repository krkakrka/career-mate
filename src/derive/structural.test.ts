import { describe, expect, it } from 'vitest';
import {
  COMPANY_STRUCTURAL_FIELDS,
  prefillRoleResearch,
  ROLE_RESEARCH_FIELDS,
  missingFields,
  prefillCompanyStructural,
  prefillRoleStructural,
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

  // The three shapes measured on live Ashby postings, which differ from
  // each other — a declaration can be one object, a list, or absent.
  it('reads an outright "European Union" declaration', () => {
    const html = posting({
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: { '@type': 'Country', name: 'European Union' },
    });
    expect(prefillRoleResearch(html)).toEqual({ remoteEu: 'yes' });
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
    expect(prefillRoleResearch(html)).toEqual({ remoteEu: 'yes' });
  });

  it('answers no when a remote role is explicitly restricted to non-EU countries', () => {
    const html = posting({
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [{ name: 'Canada' }, { name: 'United States' }],
    });
    expect(prefillRoleResearch(html)).toEqual({ remoteEu: 'no' });
  });

  it('leaves it to the model when a remote role does not say where from', () => {
    // Remote, but from where is genuinely unstated — guessing either way
    // moves the role in the priority score for no reason.
    expect(prefillRoleResearch(posting({ jobLocationType: 'TELECOMMUTE' }))).toEqual({ remoteEu: null });
  });

  it('treats a missing jobLocationType as silence, not as a denial', () => {
    // schema.org only defines the property for telecommute roles, so its
    // absence says nothing — and plenty of remote postings omit it.
    const html = posting({ jobLocation: { '@type': 'Place', address: { addressCountry: 'Germany' } } });
    expect(prefillRoleResearch(html)).toEqual({ remoteEu: null });
  });

  it.each([['Europe'], ['Worldwide'], ['Anywhere'], ['EMEA'], ['Deutschland'], ['Remote']])(
    'leaves %s to the model rather than calling it non-EU',
    (name) => {
      // These are all things publishers actually write, and none settles EU
      // eligibility. Treating an unrecognised name as non-EU scored a
      // remote-worldwide role — which *is* EU-eligible — below an
      // unresearched one, and permanently, since the model was never asked.
      const html = posting({ jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: [{ name }] });
      expect(prefillRoleResearch(html)).toEqual({ remoteEu: null });
    },
  );

  it('will not answer no when one name in the list is unrecognised', () => {
    const html = posting({
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [{ name: 'United States' }, { name: 'Freedonia' }],
    });
    expect(prefillRoleResearch(html)).toEqual({ remoteEu: null });
  });

  it('says nothing about a page with no declaration at all', () => {
    expect(prefillRoleResearch('<html><body><p>Remote, EU welcome</p></body></html>')).toEqual({ remoteEu: null });
  });

  it('leaves every other research field to the model', () => {
    const html = posting({
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: { name: 'European Union' },
    });
    // Compensation is not declared here, so the call still happens — this
    // step buys accuracy on one field, not a free research pass.
    expect(missingFields(ROLE_RESEARCH_FIELDS, prefillRoleResearch(html))).toEqual([
      'salaryMin',
      'salaryMax',
      'equity',
    ]);
  });
});
