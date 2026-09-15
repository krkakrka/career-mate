import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client.js';
import { createCompany, getCompanyById, listCompanies } from '../../db/repositories/companies.js';
import { listEventsForEntity } from '../../db/repositories/events.js';
import { listOperationalLogs } from '../../db/repositories/operational-logs.js';
import { enqueueJob, type JobRecord } from '../../db/repositories/jobs.js';
import { createRole, getRoleById, updateResearchFields } from '../../db/repositories/roles.js';
import { handleEnrichmentJob, resolveRoleCompany } from './enrichment.js';
import { restoreEnv } from '../../../test/helpers/env.js';
import { startFixtureServer } from '../../../test/helpers/fixture-server.js';
import { getDerivation } from '../../db/repositories/derivations.js';

function fakeJob(payload: unknown): JobRecord {
  return {
    id: 1,
    topic: 'enrichment',
    payload: JSON.stringify(payload),
    status: 'running',
    priority: 0,
    attempts: 0,
    available_at: new Date().toISOString(),
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    duration_ms: null,
    claimed_at: null,
    origin: 'cli',
  };
}

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-enrichment-handler-'));
  // These handlers snapshot pages through the page store, which resolves
  // its files via getDataDir(). Without this, any fixture route that
  // actually served a 200 would write into the project's real ./.data.
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Which fields the last completed research pass actually sent to the model. */
function researchModelFields(roleId: number): string[] {
  const events = listEventsForEntity(db, 'role', roleId).filter((e) => e.type === 'role.research_completed');
  return (JSON.parse(events.at(-1)!.context!) as { modelFields: string[] }).modelFields;
}

describe('resolveRoleCompany', () => {
  it('creates and attaches a new company when companyUrl is a valid http(s) URL', () => {
    const role = createRole(db, { url: 'https://example.com/jobs/1' });
    resolveRoleCompany(db, role.id, { companyName: 'Acme Corp', companyUrl: 'https://acme.example.com' });

    const updated = getRoleById(db, role.id)!;
    expect(updated.company_id).not.toBeNull();
    const company = getCompanyById(db, updated.company_id!)!;
    expect(company.url).toBe('https://acme.example.com');
    expect(company.name).toBe('Acme Corp');

    const events = listEventsForEntity(db, 'role', role.id);
    expect(events.some((e) => e.type === 'role.company_resolved')).toBe(true);
  });

  it('leaves the role unresolved when no companyUrl was extracted', () => {
    const role = createRole(db, { url: 'https://example.com/jobs/2' });
    resolveRoleCompany(db, role.id, { companyName: 'Acme Corp', companyUrl: null });

    const updated = getRoleById(db, role.id)!;
    expect(updated.company_id).toBeNull();
    const events = listEventsForEntity(db, 'role', role.id);
    expect(events.some((e) => e.type === 'role.company_unresolved')).toBe(true);
  });

  it('leaves the role unresolved (not a bogus company) when the extracted companyUrl is not a valid http(s) URL', () => {
    const role = createRole(db, { url: 'https://example.com/jobs/3' });
    resolveRoleCompany(db, role.id, { companyName: 'Acme Corp', companyUrl: 'not a url at all' });

    const updated = getRoleById(db, role.id)!;
    expect(updated.company_id).toBeNull();
    expect(listCompanies(db)).toHaveLength(0);

    const events = listEventsForEntity(db, 'role', role.id);
    const unresolvedEvent = events.find((e) => e.type === 'role.company_unresolved');
    expect(unresolvedEvent).toBeDefined();
    expect(JSON.parse(unresolvedEvent!.context!).reason).toMatch(/not a valid http/);
  });

  it('attaches to an existing matching company instead of creating a duplicate', () => {
    const existing = createCompany(db, 'https://acme.example.com', 'Acme Corp');
    const role = createRole(db, { url: 'https://example.com/jobs/4' });

    resolveRoleCompany(db, role.id, { companyName: 'Acme Corp', companyUrl: 'https://acme.example.com' });

    const updated = getRoleById(db, role.id)!;
    expect(updated.company_id).toBe(existing.id);
    expect(listCompanies(db)).toHaveLength(1);
  });

  it('does not overwrite a company already attached by a concurrent run (attachCompanyIfUnresolved race guard)', () => {
    const firstResolution = createCompany(db, 'https://first.example.com', 'First Co');
    const role = createRole(db, { url: 'https://example.com/jobs/5' });
    // Simulates another process (e.g. an overlapping rerun-enrichment)
    // already resolving this role's company between handleRoleStructural's
    // fresh re-read and this call.
    db.prepare('UPDATE roles SET company_id = ? WHERE id = ?').run(firstResolution.id, role.id);

    resolveRoleCompany(db, role.id, { companyName: 'Second Co', companyUrl: 'https://second.example.com' });

    const updated = getRoleById(db, role.id)!;
    expect(updated.company_id).toBe(firstResolution.id);

    const events = listEventsForEntity(db, 'role', role.id);
    expect(events.some((e) => e.type === 'role.company_resolution_lost_race')).toBe(true);
  });
});

describe('company-wlb job — public sources, no login', () => {
  /**
   * A company plus a real queue row.
   *
   * `recordDerivation` writes `job_id`, which is a foreign key — `fakeJob`'s
   * hardcoded id only happens to exist in tests that created a role, because
   * `createRole` enqueues one.
   */
  /** A second job for a company that already has one — the derivation key must differ for the pass to run. */
  function companyWithJob2(companyId: number): JobRecord {
    // The context is the company's own fields, which have not changed, so
    // the second pass would skip as fresh. Nudging the name is what makes
    // it a genuinely new input rather than a re-run.
    db.prepare("UPDATE companies SET name = name || ' Inc' WHERE id = ?").run(companyId);
    return enqueueJob(db, { topic: 'enrichment', payload: { kind: 'company-wlb', companyId } });
  }

  function companyWithJob(): { companyId: number; job: JobRecord } {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const job = enqueueJob(db, { topic: 'enrichment', payload: { kind: 'company-wlb', companyId: company.id } });
    return { companyId: company.id, job };
  }

  it('researches WLB and records how well-sourced the answer is', async () => {
    // The source used to be Glassdoor behind a login, which `claude -p`'s
    // web search cannot see past — so the job short-circuited and WLB was
    // never populated for anyone. It now reads public discussion, and the
    // confidence is what keeps a thin signal from moving the ranking as
    // much as a well-evidenced one.
    const { companyId, job } = companyWithJob();

    await handleEnrichmentJob(db, job);

    const updated = getCompanyById(db, companyId)!;
    expect(updated.wlb_score).not.toBeNull();
    expect(['low', 'medium', 'high']).toContain(updated.wlb_confidence);
    expect(updated.wlb_notes).toBeTruthy();
  }, 60_000);

  it('drops a confidence it cannot read rather than keeping the last one', async () => {
    // Two passes. The first stores a well-sourced 0.65/medium; the second
    // returns a score with an unusable confidence. Under COALESCE the old
    // `medium` survived and un-shrank the new number — the `salary_currency`
    // hazard on a different column.
    const { companyId, job } = companyWithJob();
    await handleEnrichmentJob(db, job);
    expect(getCompanyById(db, companyId)!.wlb_confidence).toBe('medium');

    process.env.CM_FAKE_CLAUDE_WLB = 'bad-confidence';
    try {
      await handleEnrichmentJob(db, companyWithJob2(companyId));
    } finally {
      delete process.env.CM_FAKE_CLAUDE_WLB;
    }

    const updated = getCompanyById(db, companyId)!;
    expect(updated.wlb_score).toBe(0.3);
    expect(updated.wlb_confidence).toBeNull();
  }, 60_000);

  it('clears a stale score when a later pass finds nothing', async () => {
    // The prompt explicitly asks the model to say when it found almost
    // nothing, so `null` here is a *result*. Under COALESCE the previous
    // score stayed put with the new "found nothing" notes beside it, and
    // the ranking went on using it at full weight.
    const { companyId, job } = companyWithJob();
    await handleEnrichmentJob(db, job);
    expect(getCompanyById(db, companyId)!.wlb_score).toBe(0.65);

    process.env.CM_FAKE_CLAUDE_WLB = 'nothing-found';
    try {
      await handleEnrichmentJob(db, companyWithJob2(companyId));
    } finally {
      delete process.env.CM_FAKE_CLAUDE_WLB;
    }

    const updated = getCompanyById(db, companyId)!;
    expect(updated.wlb_score).toBeNull();
    expect(updated.wlb_confidence).toBeNull();
    expect(updated.wlb_notes).toMatch(/found almost nothing/);
  }, 60_000);

  it('refuses a score on a scale it was not asked for', async () => {
    // Clamping turned a 0-10 answer of 7 into 1.0 — the best possible
    // work-life balance — and at `high` confidence that moves the ranking
    // at full weight. A value outside 0-1 is evidence of a different scale,
    // not a value to squeeze into range.
    const { companyId, job } = companyWithJob();
    process.env.CM_FAKE_CLAUDE_WLB = 'off-scale';
    try {
      await handleEnrichmentJob(db, job);
    } finally {
      delete process.env.CM_FAKE_CLAUDE_WLB;
    }

    const updated = getCompanyById(db, companyId)!;
    expect(updated.wlb_score).toBeNull();
    expect(updated.wlb_confidence).toBeNull();
  }, 60_000);

  it('does not open a browser', async () => {
    // The only daemon caller of the authenticated browser path was this
    // job. `cm auth check` and `cm auth record-har` still use it; nothing
    // in enrichment does.
    const { job } = companyWithJob();
    await handleEnrichmentJob(db, job);

    expect(fs.existsSync(path.join(tempDir, 'browser-profile'))).toBe(false);
  }, 60_000);
});

describe('role-structural with a JSON-LD JobPosting on the page', () => {
  /** A posting page whose head declares a JobPosting, as Ashby and Lever do. */
  function postingPage(org: unknown, body = '<p>Company homepage: https://globex.example.com</p>'): string {
    const ld = JSON.stringify({
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: 'Staff Platform Engineer',
      hiringOrganization: org,
    });
    return `<html><head><title>Job Application for Staff Platform Engineer at Initech</title><script type="application/ld+json">${ld}</script></head><body><h1>Engineer</h1>${body}</body></html>`;
  }

  /** What the handler recorded as having been asked of the model. */
  function modelFields(roleId: number): string[] {
    const event = listEventsForEntity(db, 'role', roleId).find((e) => e.type === 'role.structural_fetch_completed');
    return (JSON.parse(event!.context!) as { modelFields: string[] }).modelFields;
  }

  it('prefers the declaration over the model and asks only for what it omitted', async () => {
    const server = await startFixtureServer({
      '/jobs/1': postingPage({ '@type': 'Organization', name: 'Initech', sameAs: 'https://initech.example.com' }),
    });

    try {
      const role = createRole(db, { url: `${server.url}/jobs/1` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));

      // The fake model answers 'Senior Backend Engineer' for any posting, so
      // the declared title winning is what proves the preference order —
      // and that it beats the ATS boilerplate in <title> on the same page.
      expect(getRoleById(db, role.id)!.title).toBe('Staff Platform Engineer');

      // description is all that was left to pay for.
      expect(modelFields(role.id)).toEqual(['description']);

      // The declared hiringOrganization is what the role resolved against —
      // this fails if resolveRoleCompany is handed the raw extraction again.
      const company = getCompanyById(db, getRoleById(db, role.id)!.company_id!);
      expect(company).toMatchObject({ url: 'https://initech.example.com', name: 'Initech' });
    } finally {
      await server.close();
    }
  }, 60_000);

  it('still asks the model for a company URL the declaration gave unusably', async () => {
    // A bare domain is not an http(s) URL. If the prefill returned it
    // anyway, missingFields would count companyUrl as answered, isHttpUrl
    // would reject it in resolveRoleCompany, and the role would be
    // unresolvable forever — the derivation is written in the same
    // transaction, so the retry skips and --force re-derives the same value.
    const server = await startFixtureServer({
      '/jobs/2': postingPage({ '@type': 'Organization', name: 'Initech', sameAs: 'initech.example.com' }),
    });

    try {
      const role = createRole(db, { url: `${server.url}/jobs/2` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));

      expect(modelFields(role.id)).toEqual(['description', 'companyUrl']);

      // Resolved via the model's URL, keeping the declared name.
      const company = getCompanyById(db, getRoleById(db, role.id)!.company_id!);
      expect(company).toMatchObject({ url: 'https://globex.example.com', name: 'Initech' });
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe('derivation atomicity', () => {
  it('does not record a structural derivation when an effect of it fails', async () => {
    // The derivation row is the claim "this input has been fully
    // processed", and the next run skips the model on the strength of it.
    // If it could be written while an effect was still missing, a transient
    // failure would leave a role permanently half-enriched: the retry sees
    // a fresh derivation and skips everything. This reproduces that by
    // making one of the effects fail.
    const server = await startFixtureServer({
      '/jobs/1': '<html><body><h1>Engineer</h1><p>Company homepage: https://globex.example.com</p></body></html>',
    });

    try {
      const role = createRole(db, { url: `${server.url}/jobs/1` });

      // Break company resolution from under the handler: companies.url is
      // NOT NULL, so an insert of the resolved company throws inside the
      // transaction.
      db.exec('DROP TABLE companies');

      await expect(handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }))).rejects.toThrow();

      // Nothing recorded means the retry does the work again, rather than
      // skipping it as already derived.
      expect(getDerivation(db, 'role', role.id, 'role_structural')).toBeUndefined();
      // And the partial value was rolled back with it.
      expect(getRoleById(db, role.id)!.title).toBeNull();
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe('role research prefill (JSON-LD location)', () => {
  /** A posting that declares its own remote/EU eligibility, as live Ashby postings do. */
  function researchPage(location: Record<string, unknown>): string {
    const ld = JSON.stringify({
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: 'Staff Platform Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Initech', sameAs: 'https://initech.example.com' },
      ...location,
    });
    return `<html><head><script type="application/ld+json">${ld}</script></head><body><h1>Engineer</h1></body></html>`;
  }

  it('prefers the posting\'s own declaration over the model, and does not pay to ask', async () => {
    // The fake records the argv it was handed, so "the model was not asked"
    // can be asserted against the real invocation rather than against our
    // own bookkeeping — reverting the subset must fail this test.
    const callLog = path.join(tempDir, 'calls.log');
    process.env.CM_FAKE_CLAUDE_LOG = callLog;

    const server = await startFixtureServer({
      '/jobs/1': researchPage({
        jobLocationType: 'TELECOMMUTE',
        applicantLocationRequirements: [{ '@type': 'Country', name: 'Canada' }, { '@type': 'Country', name: 'United States' }],
      }),
    });

    try {
      const role = createRole(db, { url: `${server.url}/jobs/1` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      // The offline fake answers remoteEu 'yes' for every posting, so a
      // stored 'no' can only have come from the declaration — which is what
      // makes this test discriminate rather than merely pass.
      expect(getRoleById(db, role.id)!.remote_eu).toBe('no');
      expect(researchModelFields(role.id)).toEqual(['salaryMin', 'salaryMax', 'equity']);

      // The prompt that actually went out asked for three fields, not four.
      const schema = fs
        .readFileSync(callLog, 'utf-8')
        .split('\n')
        .find((line) => line.includes('matching this shape exactly'));
      expect(schema).toBeDefined();
      expect(schema).toContain('"salaryMin"');
      expect(schema).not.toContain('remoteEu');
    } finally {
      delete process.env.CM_FAKE_CLAUDE_LOG;
      await server.close();
    }
  }, 60_000);

  it('picks up a declaration the posting adds later, which text_hash cannot see', async () => {
    let declared = false;
    const server = await startFixtureServer({
      '/jobs/3': () =>
        declared
          ? researchPage({ jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { name: 'European Union' } })
          : researchPage({}),
    });

    try {
      const role = createRole(db, { url: `${server.url}/jobs/3` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));
      expect(getRoleById(db, role.id)!.remote_eu).toBe('yes'); // the fake's answer

      // The posting now declares EU eligibility. deriveText strips
      // <script>, so text_hash is unchanged and the research context is
      // unchanged — keyed on those alone, this correction would never be
      // picked up. The key covers the prefill result for exactly this.
      declared = true;
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id, force: true }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      const events = listEventsForEntity(db, 'role', role.id).filter((e) => e.type === 'role.research_completed');
      expect(events.length).toBe(2); // it did not skip as fresh
      expect(JSON.parse(events[1]!.context!).modelFields).toEqual(['salaryMin', 'salaryMax', 'equity']);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('still asks the model when the posting declares nothing about location', async () => {
    const server = await startFixtureServer({ '/jobs/2': researchPage({}) });

    try {
      const role = createRole(db, { url: `${server.url}/jobs/2` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      // Falls back to the model's answer, and remoteEu is back in the ask.
      expect(getRoleById(db, role.id)!.remote_eu).toBe('yes');
      expect(researchModelFields(role.id)).toContain('remoteEu');
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe('role research prefill (JSON-LD baseSalary)', () => {
  /** Writes the preference profile the prefill gate reads. */
  function setCurrency(currency: string | null): void {
    const dir = path.join(tempDir, 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'preferences.json'),
      JSON.stringify({ titleKeywords: [], seniority: null, remoteEuRequired: false, minSalary: null, currency }),
    );
  }

  /** The `baseSalary` shape measured on a live Ashby/ramp posting. */
  function salaryPage(baseSalary: unknown): string {
    const ld = JSON.stringify({
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: 'Staff Platform Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Initech', sameAs: 'https://initech.example.com' },
      baseSalary,
    });
    return `<html><head><script type="application/ld+json">${ld}</script></head><body><h1>Engineer</h1></body></html>`;
  }

  const annual = (currency: string) => ({
    '@type': 'MonetaryAmount',
    currency,
    value: { '@type': 'QuantitativeValue', minValue: 211400, maxValue: 290600, unitText: 'YEAR' },
  });

  it('stores the declared range with its currency and does not pay to ask', async () => {
    // Asserted against the argv the fake actually received, not against the
    // event we write ourselves — reverting the subsetting must fail this.
    const callLog = path.join(tempDir, 'calls.log');
    process.env.CM_FAKE_CLAUDE_LOG = callLog;
    setCurrency('USD');

    const server = await startFixtureServer({ '/jobs/pay': salaryPage(annual('USD')) });
    try {
      const role = createRole(db, { url: `${server.url}/jobs/pay` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      // The fake answers 90000/120000 for every posting, so these figures
      // can only have come from the declaration.
      expect(getRoleById(db, role.id)).toMatchObject({
        salary_min: 211400,
        salary_max: 290600,
        salary_currency: 'USD',
      });
      expect(researchModelFields(role.id)).toEqual(['equity', 'remoteEu']);

      // The *schema* line, not any line mentioning a field name.
      // `sources.json`'s instructions open with "Research compensation (base
      // salary min/max, equity)…", so searching for `equity` finds that
      // instead and the assertions below pass whether or not the call was
      // subsetted at all.
      const schema = fs
        .readFileSync(callLog, 'utf-8')
        .split('\n')
        .find((line) => line.includes('matching this shape exactly'));
      expect(schema).toBeDefined();
      expect(schema).toContain('"equity"');
      expect(schema).toContain('"remoteEu"');
      expect(schema).not.toContain('salaryMin');
      expect(schema).not.toContain('salaryMax');
    } finally {
      delete process.env.CM_FAKE_CLAUDE_LOG;
      await server.close();
    }
  }, 60_000);

  it('ignores a declaration in another currency, logs why, and asks the model', async () => {
    setCurrency('EUR');
    const server = await startFixtureServer({ '/jobs/jpy': salaryPage(annual('JPY')) });
    try {
      const role = createRole(db, { url: `${server.url}/jobs/jpy` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      // The fake's answer, and no currency stamped on it — the figures are
      // in whatever currency the model found, which it never reports.
      expect(getRoleById(db, role.id)).toMatchObject({
        salary_min: 90000,
        salary_max: 120000,
        salary_currency: null,
      });
      expect(researchModelFields(role.id)).toContain('salaryMin');

      const logged = listOperationalLogs(db, { action: 'salary-declaration-ignored' });
      expect(logged.length).toBe(1);
      expect(JSON.parse(logged[0]!.context!).reason).toBe('declared JPY, but preferences.currency is EUR');
    } finally {
      await server.close();
    }
  }, 60_000);

  it('never leaves half an old range beside half a new one', async () => {
    // A declared EUR range, then a withdrawn declaration and a model that
    // answers a minimum but no maximum. COALESCEing the columns separately
    // kept the old declared maximum — the figure `compFitTerm` actually
    // reads — beside the new model minimum, with the currency cleared.
    setCurrency('EUR');
    const role = createRole(db, { url: 'https://example.com/jobs/partial' });
    updateResearchFields(db, role.id, { salaryMin: 90_000, salaryMax: 110_000, salaryCurrency: 'EUR' });

    updateResearchFields(db, role.id, { salaryMin: 95_000, salaryMax: null, salaryCurrency: null });

    expect(getRoleById(db, role.id)).toMatchObject({
      salary_min: 95_000,
      salary_max: null,
      salary_currency: null,
    });
  });

  it('leaves the stored range alone when a pass reports no figures at all', async () => {
    setCurrency('EUR');
    const role = createRole(db, { url: 'https://example.com/jobs/silent' });
    updateResearchFields(db, role.id, { salaryMin: 90_000, salaryMax: 110_000, salaryCurrency: 'EUR' });

    updateResearchFields(db, role.id, { salaryMin: null, salaryMax: null, salaryCurrency: null, equity: '0.1%' });

    expect(getRoleById(db, role.id)).toMatchObject({
      salary_min: 90_000,
      salary_max: 110_000,
      salary_currency: 'EUR',
      equity: '0.1%',
    });
  });

  it('surfaces a declaration the posting adds after it was already researched', async () => {
    // The case that made logging after the freshness skip useless: a
    // JSON-LD-only edit changes no text_hash and no prefill field (the
    // declaration is declined either way), so the derivation skips — and
    // the one-line config fix would never be mentioned for exactly the
    // posting where it would start paying off.
    setCurrency(null);
    let declared = false;
    const server = await startFixtureServer({
      '/jobs/late': () => (declared ? salaryPage(annual('USD')) : salaryPage(undefined)),
    });
    try {
      const role = createRole(db, { url: `${server.url}/jobs/late` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));
      expect(listOperationalLogs(db, { action: 'salary-declaration-ignored' }).length).toBe(0);

      declared = true;
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id, force: true }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      const logged = listOperationalLogs(db, { action: 'salary-declaration-ignored' });
      expect(logged.length).toBe(1);
      expect(JSON.parse(logged[0]!.context!).reason).toBe(
        'declared USD; set preferences.currency to accept declared pay',
      );
    } finally {
      await server.close();
    }
  }, 60_000);

  it('reports a different reason once the first one is fixed', async () => {
    // The reason is part of the log's identity, so moving from "unset" to
    // "set to the wrong one" is still reported rather than deduped away.
    setCurrency(null);
    const server = await startFixtureServer({ '/jobs/reason': salaryPage(annual('USD')) });
    try {
      const role = createRole(db, { url: `${server.url}/jobs/reason` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      setCurrency('EUR');
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      const reasons = listOperationalLogs(db, { action: 'salary-declaration-ignored' })
        .map((log) => JSON.parse(log.context!).reason as string)
        .sort();
      expect(reasons).toEqual([
        'declared USD, but preferences.currency is EUR',
        'declared USD; set preferences.currency to accept declared pay',
      ]);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('does not log the same unusable declaration on every later refresh', async () => {
    // `cm refresh` re-enqueues research for every role it touches. Logging
    // before the freshness check wrote one of these per role per refresh,
    // forever, for a posting nothing had re-derived.
    setCurrency('EUR');
    const server = await startFixtureServer({ '/jobs/repeat': salaryPage(annual('JPY')) });
    try {
      const role = createRole(db, { url: `${server.url}/jobs/repeat` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      expect(listOperationalLogs(db, { action: 'salary-declaration-ignored' }).length).toBe(1);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('says what to configure when a declaration arrives with no preference currency set', async () => {
    // The shipped default. The declaration is unusable, but the reason is a
    // one-line config fix, and paying for the search instead would never
    // say so.
    setCurrency(null);
    const server = await startFixtureServer({ '/jobs/unset': salaryPage(annual('USD')) });
    try {
      const role = createRole(db, { url: `${server.url}/jobs/unset` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      expect(getRoleById(db, role.id)!.salary_min).toBe(90000); // the fake's answer
      const logged = listOperationalLogs(db, { action: 'salary-declaration-ignored' });
      expect(JSON.parse(logged[0]!.context!).reason).toBe(
        'declared USD; set preferences.currency to accept declared pay',
      );
    } finally {
      await server.close();
    }
  }, 60_000);

  it('clears a stale currency when later figures come from the model', async () => {
    // A role prefilled as USD, then re-researched after the declaration is
    // withdrawn. The currency must not outlive the figures it described.
    setCurrency('USD');
    let declared = true;
    const server = await startFixtureServer({
      '/jobs/withdrawn': () => (declared ? salaryPage(annual('USD')) : salaryPage(undefined)),
    });
    try {
      const role = createRole(db, { url: `${server.url}/jobs/withdrawn` });
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));
      expect(getRoleById(db, role.id)!.salary_currency).toBe('USD');

      declared = false;
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-structural', roleId: role.id, force: true }));
      await handleEnrichmentJob(db, fakeJob({ kind: 'role-research', roleId: role.id }));

      expect(getRoleById(db, role.id)).toMatchObject({
        salary_min: 90000,
        salary_max: 120000,
        salary_currency: null,
      });
    } finally {
      await server.close();
    }
  }, 60_000);
});
