import { describe, expect, it } from 'vitest';
import {
  COMPANY_STRUCTURAL_FIELDS,
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
