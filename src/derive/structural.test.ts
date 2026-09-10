import { describe, expect, it } from 'vitest';
import {
  COMPANY_STRUCTURAL_FIELDS,
  missingFields,
  prefillCompanyStructural,
  prefillRoleStructural,
  ROLE_STRUCTURAL_FIELDS,
} from './structural.js';

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
    expect(prefillRoleStructural(html)).toEqual({ title: null });
  });

  it('leaves the whole role title to the model, having no rule more reliable than it', () => {
    expect(prefillRoleStructural('<body><p>Join us</p></body>')).toEqual({ title: null });
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
