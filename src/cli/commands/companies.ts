import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { ensureDaemonRunning } from '../../lib/daemon-control.js';
import { DuplicateError, NotFoundError } from '../../db/errors.js';
import {
  createCompany,
  findCompanyByUrl,
  getCompanyById,
  listCompanies,
  setConnections,
  setPreferenceRating,
  type Company,
} from '../../db/repositories/companies.js';
import {
  companyFieldGroupStatus,
  currentRecipeVersions,
  markersByKind,
  recomputeFloorMs,
} from '../../derive/view-staleness.js';
import { companyStructuralPayload } from '../../domain/enrichment-payload.js';
import { enqueueEnrichment, enqueueRecomputesAndRun, queueRecomputes } from '../enqueue-enrichment.js';
import { reportKnownErrors } from '../handle-known-errors.js';
import { parseHttpUrl, parsePositiveInt, parseRating } from '../parsers.js';

const KNOWN_ERRORS = [DuplicateError, NotFoundError];

function suffix(marker: string | undefined): string {
  return marker ? `  ${marker}` : '';
}

function printCompanyDetail(company: Company, markers: Map<string, string>): void {
  const structural = suffix(markers.get('company_structural'));
  const research = suffix(markers.get('company_research'));

  console.log(`#${company.id} ${company.name ?? '(unnamed — not yet fetched)'}${structural}`);
  console.log(`URL: ${company.url}`);
  console.log(`Description: ${company.description ?? '(none yet)'}${structural}`);
  console.log(`Preference rating: ${company.preference_rating}`);
  console.log(`Connections: ${company.connections ?? '(none)'}`);
  console.log(`IPO status: ${company.ipo_status ?? '(unknown)'}${research}`);
  console.log(`AI-proof score: ${company.ai_proof_score ?? '(unknown)'}${company.ai_proof_notes ? `  — ${company.ai_proof_notes}` : ''}${research}`);
  console.log(`WLB score: ${company.wlb_score ?? '(unknown)'}${company.wlb_notes ? `  — ${company.wlb_notes}` : ''}`);
  console.log(`Created: ${company.created_at}`);
}

export function registerCompaniesCommand(program: Command): void {
  const companies = program.command('companies').description('Manage tracked companies');

  companies
    .command('add')
    .description('Add a company by URL, or re-fetch one already tracked with --force')
    .argument('<url>', 'Company URL', parseHttpUrl)
    .option('--force', 'Take a new snapshot of the page now, ignoring settings.page_refresh_days')
    .action((url: string, opts: { force?: boolean }) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();

        // Adding a URL already tracked is a no-op that prints what's there,
        // not an error: `add` is how you say "I want this tracked", and it
        // already is. --force is the way to ask for a fresh look at it.
        const existing = findCompanyByUrl(db, url);
        if (existing) {
          if (!opts.force) {
            console.log(`Already tracking company #${existing.id}: ${existing.url}`);
            const groups = companyFieldGroupStatus(db, existing);
            enqueueRecomputesAndRun(db, 'company', existing.id, groups);
            printCompanyDetail(existing, markersByKind(groups));
            return;
          }
          enqueueEnrichment(db, companyStructuralPayload(existing.id, true));
          console.log(`Re-fetching company #${existing.id}: ${existing.url} (in the background)`);
          return;
        }

        const company = createCompany(db, url);
        enqueueEnrichment(db, companyStructuralPayload(company.id, opts.force ?? false));
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
      // Read once for the whole list, like the scoring weights above.
      const floorMs = recomputeFloorMs();
      const recipes = currentRecipeVersions();
      let anyOutstanding = false;
      for (const company of rows) {
        const groups = companyFieldGroupStatus(db, company, recipes);
        anyOutstanding = queueRecomputes(db, 'company', company.id, groups, floorMs) || anyOutstanding;
        const marker = groups.some((group) => group.marker === '(stale)') ? '  (stale)' : '';
        console.log(
          `#${company.id}  ${company.name ?? '(unnamed)'}  ${company.url}  pref=${company.preference_rating}${marker}`,
        );
      }
      // Once for the whole list, not once per row.
      if (anyOutstanding) ensureDaemonRunning();
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
      // Reading is what triggers a recompute — no eager sweep, no
      // invalidation cascade. Debounced, so repeated `show` calls leave one
      // job per group rather than one per read.
      const groups = companyFieldGroupStatus(db, company);
      enqueueRecomputesAndRun(db, 'company', company.id, groups);
      printCompanyDetail(company, markersByKind(groups));
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
    .description('Deprecated alias for `cm companies add <url> --force`')
    .argument('<id>', 'Company id', parsePositiveInt)
    .action((id: number) => {
      const db = getDb();
      const company = getCompanyById(db, id);
      if (!company) {
        console.error(`Company #${id} not found`);
        process.exitCode = 1;
        return;
      }
      enqueueEnrichment(db, companyStructuralPayload(id, true));
      console.log(`Re-enrichment queued for company #${id}.`);
      console.log(`Note: rerun-enrichment is deprecated — \`cm companies add ${company.url} --force\` does the same thing.`);
    });
}
