import { describe, expect, it } from 'vitest';

import { findJobPostingLd } from './jsonld.js';

/** Wrap a JSON-LD payload the way a page does, without touching its bytes. */
function page(json: string, attrs = 'type="application/ld+json"'): string {
  return `<html><head><title>irrelevant</title><script ${attrs}>${json}</script></head><body>x</body></html>`;
}

const ashby = JSON.stringify({
  '@context': 'https://schema.org/',
  '@type': 'JobPosting',
  title: 'Software Engineer, Agents & Automations',
  description: '<p>Who are we?</p>',
  datePosted: '2026-06-15',
  hiringOrganization: {
    '@type': 'Organization',
    name: 'Cohere',
    sameAs: 'https://cohere.com/',
  },
});

describe('findJobPostingLd', () => {
  it('reads title, company name and company URL from a real ATS payload', () => {
    expect(findJobPostingLd(page(ashby))).toEqual({
      title: 'Software Engineer, Agents & Automations',
      companyName: 'Cohere',
      companyUrl: 'https://cohere.com/',
      jobLocationType: null,
      applicantCountries: [],
      baseSalary: null,
    });
  });

  it('does not decode HTML entities', () => {
    // Script content is raw text in HTML, so a conforming producer writes a
    // literal `&` in the title (as Ashby does) and `&amp;` only where it is
    // genuinely part of an embedded HTML string. Running the block through an
    // entity decoder would turn the second into `&` and silently corrupt it.
    const html = page(JSON.stringify({ '@type': 'JobPosting', title: 'R&D &amp; Platform' }));
    expect(findJobPostingLd(html)?.title).toBe('R&D &amp; Platform');
  });

  it('finds the JobPosting among several blocks', () => {
    const other = JSON.stringify({ '@type': 'BreadcrumbList', itemListElement: [] });
    const html = `<head>${page(other).match(/<script[\s\S]*<\/script>/)![0]}${page(ashby).match(/<script[\s\S]*<\/script>/)![0]}</head>`;
    expect(findJobPostingLd(html)?.title).toBe('Software Engineer, Agents & Automations');
  });

  it('unwraps @graph and top-level arrays', () => {
    const graph = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, JSON.parse(ashby)] });
    expect(findJobPostingLd(page(graph))?.companyName).toBe('Cohere');

    const array = JSON.stringify([{ '@type': 'Organization', name: 'Nope' }, JSON.parse(ashby)]);
    expect(findJobPostingLd(page(array))?.companyName).toBe('Cohere');
  });

  it('accepts @type given as an array', () => {
    const html = page(JSON.stringify({ '@type': ['JobPosting', 'Thing'], title: 'Staff Engineer' }));
    expect(findJobPostingLd(html)?.title).toBe('Staff Engineer');
  });

  it('tolerates script tag attribute variations', () => {
    expect(findJobPostingLd(page(ashby, "id='ld' type='application/ld+json'"))?.title).toBe(
      'Software Engineer, Agents & Automations',
    );
    expect(findJobPostingLd(page(ashby, 'type = "application/ld+json" defer'))?.title).toBe(
      'Software Engineer, Agents & Automations',
    );
  });

  it('returns null rather than throwing on malformed JSON', () => {
    // A truncated or hand-edited block must not take down the enrichment
    // handler — the whole point of the prefill is that it is the free pass.
    expect(findJobPostingLd(page('{"@type": "JobPosting", "title": '))).toBeNull();
    expect(findJobPostingLd(page('not json at all'))).toBeNull();
  });

  it('keeps scanning after a malformed block', () => {
    const broken = '<script type="application/ld+json">{oops</script>';
    const good = page(ashby).match(/<script[\s\S]*<\/script>/)![0];
    expect(findJobPostingLd(`<head>${broken}${good}</head>`)?.companyName).toBe('Cohere');
  });

  it('returns null when there is no JobPosting', () => {
    expect(findJobPostingLd('<html><body>no structured data</body></html>')).toBeNull();
    expect(findJobPostingLd(page(JSON.stringify({ '@type': 'Organization', name: 'Acme' })))).toBeNull();
  });

  it('nulls individual fields it cannot read, keeping the ones it can', () => {
    const html = page(JSON.stringify({ '@type': 'JobPosting', title: '  Senior Engineer  ' }));
    expect(findJobPostingLd(html)).toEqual({
      title: 'Senior Engineer',
      companyName: null,
      companyUrl: null,
      jobLocationType: null,
      applicantCountries: [],
      baseSalary: null,
    });
  });

  it('ignores blank and non-string values', () => {
    const html = page(
      JSON.stringify({
        '@type': 'JobPosting',
        title: '   ',
        hiringOrganization: { name: 42, sameAs: '' },
      }),
    );
    expect(findJobPostingLd(html)).toEqual({
      title: null,
      companyName: null,
      companyUrl: null,
      jobLocationType: null,
      applicantCountries: [],
      baseSalary: null,
    });
  });

  it('handles hiringOrganization given as an array or a bare string', () => {
    const asArray = page(
      JSON.stringify({ '@type': 'JobPosting', hiringOrganization: [{ name: 'Acme', sameAs: 'https://acme.com' }] }),
    );
    expect(findJobPostingLd(asArray)).toMatchObject({ companyName: 'Acme', companyUrl: 'https://acme.com' });

    const asString = page(JSON.stringify({ '@type': 'JobPosting', hiringOrganization: 'Acme' }));
    expect(findJobPostingLd(asString)).toMatchObject({ companyName: 'Acme', companyUrl: null });
  });

  it('handles the real Lever shape, which declares a name but no sameAs', () => {
    // Measured against a live Lever posting: hiringOrganization carries
    // `name` and `logo` only. companyUrl must come back null so that
    // missingFields still routes it to the model, rather than the role
    // being left unresolvable.
    const html = page(
      JSON.stringify({
        '@type': 'JobPosting',
        title: 'Analytics Engineer',
        hiringOrganization: { '@type': 'Organization', name: 'Metabase', logo: 'https://example.com/logo.png' },
      }),
    );
    expect(findJobPostingLd(html)).toEqual({
      title: 'Analytics Engineer',
      companyName: 'Metabase',
      companyUrl: null,
      jobLocationType: null,
      applicantCountries: [],
      baseSalary: null,
    });
  });

  describe('company URL', () => {
    const withOrg = (org: unknown) => page(JSON.stringify({ '@type': 'JobPosting', hiringOrganization: org }));

    it.each([
      ['a bare domain', 'acme.com'],
      ['a relative path', '/company/acme'],
      ['a mailto', 'mailto:jobs@acme.com'],
      ['a protocol-relative URL', '//acme.com'],
    ])('returns null for %s rather than an unusable string', (_label, sameAs) => {
      // Load-bearing: missingFields treats any non-null prefill as answered,
      // so returning an unusable value here would drop companyUrl from the
      // model's field list, fail isHttpUrl in resolveRoleCompany, and leave
      // the role permanently unresolved — the derivation is written in the
      // same transaction, so the retry skips and --force re-derives the same
      // bad value.
      expect(findJobPostingLd(withOrg({ name: 'Acme', sameAs }))?.companyUrl).toBeNull();
    });

    it.each([
      ['LinkedIn', 'https://www.linkedin.com/company/acme'],
      ['the ATS it is hosted on', 'https://jobs.ashbyhq.com/acme'],
      ['Greenhouse', 'https://boards.greenhouse.io/acme'],
      ['Wikipedia', 'https://en.wikipedia.org/wiki/Acme'],
    ])('rejects %s, which is a conforming sameAs but not a company site', (_label, sameAs) => {
      // schema.org defines sameAs as a reference page identifying the item,
      // so these are all valid. Accepting one would key the company on it and
      // then fetch it for a description. Null sends it to the model, whose
      // prompt carries the same guard with more context to apply it.
      expect(findJobPostingLd(withOrg({ name: 'Acme', sameAs }))?.companyUrl).toBeNull();
    });

    it('prefers url, schema.org\'s property for the item\'s own site, over sameAs', () => {
      const org = { name: 'Acme', url: 'https://acme.com', sameAs: 'https://www.linkedin.com/company/acme' };
      expect(findJobPostingLd(withOrg(org))?.companyUrl).toBe('https://acme.com');
    });

    it('picks the company site out of a sameAs array of profiles', () => {
      const org = {
        name: 'Acme',
        sameAs: ['https://www.linkedin.com/company/acme', 'https://x.com/acme', 'https://acme.com'],
      };
      expect(findJobPostingLd(withOrg(org))?.companyUrl).toBe('https://acme.com');
    });

    it('matches blocked hosts on subdomains but not on lookalikes', () => {
      expect(findJobPostingLd(withOrg({ sameAs: 'https://careers.lever.co/acme' }))?.companyUrl).toBeNull();
      // `notlinkedin.com` merely ends with the same letters; it is a
      // different registrable domain and must not be rejected.
      expect(findJobPostingLd(withOrg({ sameAs: 'https://notlinkedin.com' }))?.companyUrl).toBe('https://notlinkedin.com');
    });
  });

  it('ignores a JSON-LD payload parked in a template script', () => {
    // `-` is a non-word character, so a \b before `type` also holds inside
    // `data-type`: an SPA stashing an un-rendered template would otherwise be
    // read as though the page declared it, and prefilled with no model call
    // to correct it.
    const html = `<script data-type="application/ld+json" type="text/template">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'TEMPLATE',
    })}</script>`;
    expect(findJobPostingLd(html)).toBeNull();
  });

  it('is not stateful across calls', () => {
    // A module-level /g regex would carry lastIndex between calls and make
    // every second call miss.
    const html = page(ashby);
    expect(findJobPostingLd(html)?.title).toBe(findJobPostingLd(html)?.title);
    expect(findJobPostingLd(html)).not.toBeNull();
  });
});

describe('findJobPostingLd baseSalary', () => {
  const salary = (baseSalary: unknown) => findJobPostingLd(page(JSON.stringify({ '@type': 'JobPosting', baseSalary })))?.baseSalary;

  it('reads the MonetaryAmount shape measured on a live Ashby posting', () => {
    expect(
      salary({
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: { '@type': 'QuantitativeValue', minValue: 211400, maxValue: 290600, unitText: 'YEAR' },
      }),
    ).toEqual({ currency: 'USD', unitText: 'YEAR', min: 211400, max: 290600 });
  });

  it('reads a bare numeric value as an exact figure', () => {
    expect(salary({ currency: 'EUR', unitText: 'YEAR', value: 120000 })).toEqual({
      currency: 'EUR',
      unitText: 'YEAR',
      min: 120000,
      max: 120000,
    });
  });

  it('prefers unitText on the value but falls back to the amount', () => {
    // schema.org's own examples put it on the QuantitativeValue; publishers
    // put it in both places.
    expect(salary({ currency: 'EUR', unitText: 'MONTH', value: { minValue: 1, maxValue: 2, unitText: 'YEAR' } })?.unitText).toBe('YEAR');
    expect(salary({ currency: 'EUR', unitText: 'YEAR', value: { minValue: 1, maxValue: 2 } })?.unitText).toBe('YEAR');
  });

  it('uppercases currency and unit so a lower-cased declaration still matches', () => {
    expect(salary({ currency: 'usd', value: { value: 1, unitText: 'year' } })).toMatchObject({ currency: 'USD', unitText: 'YEAR' });
  });

  it('orders a range declared backwards', () => {
    expect(salary({ currency: 'EUR', value: { minValue: 200, maxValue: 100, unitText: 'YEAR' } })).toMatchObject({ min: 100, max: 200 });
  });

  it('returns null when only one end of the range is declared', () => {
    // All-or-nothing: the consumer writes min, max and currency as a unit,
    // so half a declaration would be stamped with a currency describing
    // only half the row.
    expect(salary({ currency: 'EUR', value: { minValue: 90000, unitText: 'YEAR' } })).toBeNull();
  });

  it('rejects non-numeric, zero and negative figures', () => {
    expect(salary({ currency: 'EUR', value: { minValue: '90000', maxValue: '110000', unitText: 'YEAR' } })).toBeNull();
    expect(salary({ currency: 'EUR', value: { minValue: 0, maxValue: 0, unitText: 'YEAR' } })).toBeNull();
    expect(salary({ currency: 'EUR', value: { minValue: -1, maxValue: -1, unitText: 'YEAR' } })).toBeNull();
  });

  it('carries a missing currency or unit through as null rather than guessing', () => {
    // The judgement about what is usable belongs to the prefill rule, which
    // is the only place that knows what your floor is denominated in.
    expect(salary({ value: { minValue: 1, maxValue: 2 } })).toEqual({ currency: null, unitText: null, min: 1, max: 2 });
  });

  it('unwraps baseSalary given as an array', () => {
    expect(salary([{ currency: 'EUR', value: { value: 5, unitText: 'YEAR' } }])).toMatchObject({ currency: 'EUR', min: 5 });
  });

  it('is null when the posting declares no pay', () => {
    expect(findJobPostingLd(page(ashby))?.baseSalary).toBeNull();
  });
});
