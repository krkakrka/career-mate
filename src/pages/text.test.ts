import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, deriveText, extractCanonicalUrl, extractOgMeta, extractTitle } from './text.js';

const JOB_PAGE = `<!doctype html>
<html>
  <head>
    <title>Senior Backend Engineer &mdash; Example Co</title>
    <meta charset="utf-8">
    <meta property="og:title" content="Senior Backend Engineer">
    <meta content="Build payments infrastructure" property="og:description">
    <meta name="description" content="not an og tag">
    <style>.hero { color: red }</style>
    <script>window.__DATA__ = { salary: 1 };</script>
  </head>
  <body>
    <!-- navigation -->
    <h1>Senior Backend Engineer</h1>
    <p>We&rsquo;re hiring in Berlin &amp; Amsterdam.</p>
    <ul>
      <li>5+ years experience</li>
      <li>Remote within the EU</li>
    </ul>
    <noscript>Please enable JavaScript.</noscript>
  </body>
</html>`;

describe('deriveText', () => {
  it('derives an exact, stable text form: title/og header block, then visible text only', () => {
    expect(deriveText(JOB_PAGE)).toBe(
      [
        'title: Senior Backend Engineer — Example Co',
        'og:title: Senior Backend Engineer',
        'og:description: Build payments infrastructure',
        '',
        'Senior Backend Engineer',
        'We’re hiring in Berlin & Amsterdam.',
        '5+ years experience',
        'Remote within the EU',
      ].join('\n'),
    );
  });

  it('is much smaller than the HTML it came from', () => {
    expect(deriveText(JOB_PAGE).length).toBeLessThan(JOB_PAGE.length / 2);
  });

  it('is deterministic — the same input always derives the same text', () => {
    expect(deriveText(JOB_PAGE)).toBe(deriveText(JOB_PAGE));
  });

  it('drops the contents of script, style, noscript, svg and comments', () => {
    const text = deriveText(JOB_PAGE);
    expect(text).not.toContain('__DATA__');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('enable JavaScript');
    expect(text).not.toContain('navigation');
  });

  it('keeps block elements on separate lines rather than running them together', () => {
    expect(deriveText('<div>Alpha</div><div>Beta</div>')).toBe('Alpha\nBeta');
    expect(deriveText('<p>One<br>Two</p>')).toBe('One\nTwo');
  });

  it('keeps inline elements on one line', () => {
    expect(deriveText('<p>Salary <strong>€90k</strong> to <em>€120k</em></p>')).toBe('Salary €90k to €120k');
  });

  it('collapses whitespace runs, non-breaking spaces and blank lines', () => {
    expect(deriveText('<p>a   b\n\n\tc&nbsp;&nbsp;d</p><div></div><div>e</div>')).toBe('a b c d\ne');
  });

  it('strips an unterminated <head>, so the title is not repeated in the body', () => {
    // </head> is optional in HTML; minified pages routinely omit it.
    const text = deriveText('<html><head><title>Staff Engineer</title><body><p>Join us</p></body></html>');
    expect(text).toBe('title: Staff Engineer\n\nJoin us');
  });

  it('handles a page with no head, title or og tags', () => {
    expect(deriveText('<body><p>Bare page</p></body>')).toBe('Bare page');
  });

  it('emits only the header when the page has no body text', () => {
    expect(deriveText('<html><head><title>Just a title</title></head><body></body></html>')).toBe('title: Just a title');
  });

  it('returns an empty string for an empty document', () => {
    expect(deriveText('')).toBe('');
  });
});

describe('link preservation', () => {
  // extract-structural.sh asks the model for a role's companyUrl "from the
  // page content or links", and resolveRoleCompany depends on the answer.
  // On a real ATS posting the employer's domain appears only as a logo
  // link, so a derivation that dropped hrefs would silently break company
  // resolution.
  it('writes an absolute link target inline beside its anchor text', () => {
    expect(deriveText('<p>Posted by <a href="https://example.com">Example Co</a></p>')).toBe(
      'Posted by Example Co (https://example.com)',
    );
  });

  it('does not repeat a link whose text is already the URL', () => {
    expect(deriveText('<a href="https://example.com">https://example.com</a>')).toBe('https://example.com');
  });

  it('does not attribute a URL from inside a script to a real anchor', () => {
    // Inline JS routinely carries HTML templates — a __NEXT_DATA__ blob on
    // an ATS page is exactly this shape. An unterminated `<a href=...>` in
    // there used to pair with the next real </a> in the body, so the model
    // was told the employer's homepage was a CDN/tracking domain, and
    // resolveRoleCompany would attach that as the company.
    const html =
      `<html><body><script>var tpl = "<a href='https://cdn.example.com/track'>";</script>` +
      `<p>Posted by <a href="https://acme.example.com">Acme Corp</a></p></body></html>`;

    expect(deriveText(html)).toBe('Posted by Acme Corp (https://acme.example.com)');
  });

  it('ignores relative and non-http link targets, which tell an extractor nothing', () => {
    expect(deriveText('<a href="/apply">Apply</a> <a href="javascript:void(0)">Menu</a>')).toBe('Apply Menu');
  });

  it('keeps the declared canonical URL in the header block', () => {
    expect(
      deriveText('<html><head><link rel="canonical" href="https://example.com/jobs/1"></head><body>Hi</body></html>'),
    ).toBe('canonical: https://example.com/jobs/1\n\nHi');
  });
});

describe('extractCanonicalUrl', () => {
  it('reads rel=canonical regardless of attribute order, ignoring other link tags', () => {
    expect(extractCanonicalUrl('<link rel="stylesheet" href="a.css"><link href="https://x.test/p" rel="canonical">')).toBe(
      'https://x.test/p',
    );
  });

  it('is undefined when the page declares none', () => {
    expect(extractCanonicalUrl('<link rel="stylesheet" href="a.css">')).toBeUndefined();
  });
});

describe('extractTitle', () => {
  it('reads and cleans the title', () => {
    expect(extractTitle('<title>  Hello &amp; welcome  </title>')).toBe('Hello & welcome');
  });

  it('is undefined when absent or empty', () => {
    expect(extractTitle('<html><body>x</body></html>')).toBeUndefined();
    expect(extractTitle('<title>   </title>')).toBeUndefined();
  });
});

describe('extractOgMeta', () => {
  it('reads og tags in document order regardless of attribute order or quoting', () => {
    expect(
      extractOgMeta(`<meta property="og:type" content='website'><meta content=Example property=og:site_name>`),
    ).toEqual([
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Example' },
    ]);
  });

  it('keeps repeated properties rather than collapsing them', () => {
    expect(
      extractOgMeta('<meta property="og:image" content="a.png"><meta property="og:image" content="b.png">'),
    ).toHaveLength(2);
  });

  it('is not fooled by a data- attribute that ends in the name it looks for', () => {
    // \b matches after a hyphen, so a naive pattern reads data-content
    // here and puts a tracking id where the og value belongs.
    expect(
      extractOgMeta('<meta property="og:title" data-content="tracking-id" content="Senior Engineer">'),
    ).toEqual([{ property: 'og:title', content: 'Senior Engineer' }]);
  });

  it('ignores non-og meta tags and og tags with no content', () => {
    expect(extractOgMeta('<meta name="viewport" content="width=device-width"><meta property="og:title">')).toEqual([]);
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named, decimal and hex entities in a single pass', () => {
    expect(decodeHtmlEntities('&lt;b&gt; &#8364;90k &#x2014; done')).toBe('<b> €90k — done');
  });

  it('does not double-decode an escaped entity', () => {
    expect(decodeHtmlEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('respects entity case, which HTML entity names are sensitive to', () => {
    expect(decodeHtmlEntities('&eacute;clair vs &Eacute;clair')).toBe('éclair vs Éclair');
  });

  it('leaves unknown and out-of-range entities untouched', () => {
    expect(decodeHtmlEntities('&notarealentity; &#1114112; &#xD800;')).toBe('&notarealentity; &#1114112; &#xD800;');
  });
});
