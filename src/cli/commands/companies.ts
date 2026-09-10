import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { DuplicateError, NotFoundError } from '../../db/errors.js';
import {
  createCompany,
  getCompanyById,
  listCompanies,
  setConnections,
  setPreferenceRating,
  type Company,
} from '../../db/repositories/companies.js';
import { recomputePriorityForCompanyRoles } from '../../scoring/priority.js';
import { enqueueEnrichment } from '../enqueue-enrichment.js';
import { reportKnownErrors } from '../handle-known-errors.js';
import { parseHttpUrl, parsePositiveInt, parseRating } from '../parsers.js';

const KNOWN_ERRORS = [DuplicateError, NotFoundError];

function printCompanyDetail(company: Company): void {
  console.log(`#${company.id} ${company.name ?? '(unnamed — not yet fetched)'}`);
  console.log(`URL: ${company.url}`);
  console.log(`Description: ${company.description ?? '(none yet)'}`);
  console.log(`Preference rating: ${company.preference_rating}`);
  console.log(`Connections: ${company.connections ?? '(none)'}`);
  console.log(`IPO status: ${company.ipo_status ?? '(unknown)'}`);
  console.log(`AI-proof score: ${company.ai_proof_score ?? '(unknown)'}${company.ai_proof_notes ? `  — ${company.ai_proof_notes}` : ''}`);
  console.log(`WLB score: ${company.wlb_score ?? '(unknown)'}${company.wlb_notes ? `  — ${company.wlb_notes}` : ''}`);
  console.log(`Created: ${company.created_at}`);
}

export function registerCompaniesCommand(program: Command): void {
  const companies = program.command('companies').description('Manage tracked companies');

  companies
    .command('add')
    .description('Add a new company by URL. This will trigger enrichment process')
    .argument('<url>', 'Company URL', parseHttpUrl)
    .action((url: string) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        const company = createCompany(db, url);
        enqueueEnrichment(db, { kind: 'company-structural', companyId: company.id });
        console.log(`Added company #${company.id}: ${company.url} (fetching details in the background)`);
      });
    });

  companies
    .command('list')
    .description('List tracked companies')
    .action(() => {
      const db = getDb();
      const rows = listCompanies(db);
      if (rows.length === 0) {
        console.log('No companies tracked yet. Add one with `cm companies add <url>`.');
        return;
      }
      for (const company of rows) {
        console.log(
          `#${company.id}  ${company.name ?? '(unnamed)'}  ${company.url}  pref=${company.preference_rating}`,
        );
      }
    });

  companies
    .command('show')
    .description('Show company detail')
    .argument('<id>', 'Company id', parsePositiveInt)
    .action((id: number) => {
      const db = getDb();
      const company = getCompanyById(db, id);
      if (!company) {
        console.error(`Company #${id} not found`);
        process.exitCode = 1;
        return;
      }
      printCompanyDetail(company);
    });

  companies
    .command('set-preference')
    .description('Set your manual preference rating for a company (-2 to 2)')
    .argument('<id>', 'Company id', parsePositiveInt)
    .argument('<rating>', 'Preference rating, -2 to 2', parseRating)
    .action((id: number, rating: number) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        const company = setPreferenceRating(db, id, rating);
        recomputePriorityForCompanyRoles(db, id);
        console.log(`Company #${company.id} preference rating set to ${company.preference_rating}`);
      });
    });

  companies
    .command('set-connections')
    .description('Record a personal connection/referral note for a company')
    .argument('<id>', 'Company id', parsePositiveInt)
    .argument('<note>', 'Connections note')
    .action((id: number, note: string) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        const company = setConnections(db, id, note);
        console.log(`Company #${company.id} connections note updated`);
      });
    });

  companies
    .command('rerun-enrichment')
    .description('Re-fetch a company page (ignoring the snapshot refresh window) and re-run structural fetch + full research')
    .argument('<id>', 'Company id', parsePositiveInt)
    .action((id: number) => {
      const db = getDb();
      const company = getCompanyById(db, id);
      if (!company) {
        console.error(`Company #${id} not found`);
        process.exitCode = 1;
        return;
      }
      // force: see the note on `roles rerun-enrichment`.
      enqueueEnrichment(db, { kind: 'company-structural', companyId: id, force: true });
      console.log(`Re-enrichment queued for company #${id}.`);
    });
}
