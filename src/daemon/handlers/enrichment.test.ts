import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client.js';
import { createCompany, getCompanyById, listCompanies } from '../../db/repositories/companies.js';
import { listEventsForEntity } from '../../db/repositories/events.js';
import type { JobRecord } from '../../db/repositories/jobs.js';
import { createRole, getRoleById } from '../../db/repositories/roles.js';
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

describe('company-wlb job — no urlTemplate configured (the shipped default)', () => {
  it('skips gracefully with a clear event instead of attempting doomed browser automation, no live calls', async () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');

    // No live claude -p / Playwright call should happen here at all — WLB
    // is login-gated, so without a real urlTemplate in sources.json there
    // is nothing reachable to research. This must stay fast and free.
    const start = Date.now();
    await handleEnrichmentJob(db, fakeJob({ kind: 'company-wlb', companyId: company.id }));
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);

    const updated = getCompanyById(db, company.id)!;
    expect(updated.wlb_score).toBeNull();

    const events = listEventsForEntity(db, 'company', company.id);
    const skipped = events.find((e) => e.type === 'company.wlb_skipped');
    expect(skipped).toBeDefined();
    expect(JSON.parse(skipped!.context!).reason).toMatch(/urlTemplate/);
  });
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

  function researchModelFields(roleId: number): string[] {
    const event = listEventsForEntity(db, 'role', roleId).find((e) => e.type === 'role.research_completed');
    return (JSON.parse(event!.context!) as { modelFields: string[] }).modelFields;
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
      const research = fs
        .readFileSync(callLog, 'utf-8')
        .split('\n')
        .find((line) => line.includes('salaryMin'));
      expect(research).toBeDefined();
      expect(research).not.toContain('remoteEu');
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
