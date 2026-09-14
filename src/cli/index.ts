import { Command } from 'commander';
import { registerCompaniesCommand } from './commands/companies.js';
import { registerRolesCommand } from './commands/roles.js';
import { registerRecruitersCommand } from './commands/recruiters.js';
import { registerInterviewNoteCommand } from './commands/interview-notes.js';
import { registerTipsCommand } from './commands/tips.js';
import { registerRefreshCommand } from './commands/refresh.js';
import { registerDiscoverCommand } from './commands/discover.js';
import { registerStatusCommand } from './commands/status.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerDaemonCommand } from './commands/daemon.js';
import { registerWorkerCommand } from './commands/worker.js';
import { registerEventsCommand } from './commands/events.js';
import { registerLogsCommand } from './commands/logs.js';
import { installCliOperationalLogging, takeRunningAction } from './operational-logging.js';

const program = new Command();

program
  .name('cm')
  .description('career-mate — track and enrich your job search pipeline')
  .version('0.1.0');

registerCompaniesCommand(program);
registerRolesCommand(program);
registerRecruitersCommand(program);
registerInterviewNoteCommand(program);
registerTipsCommand(program);
registerRefreshCommand(program);
registerDiscoverCommand(program);
registerStatusCommand(program);
registerAuthCommand(program);
registerDaemonCommand(program);
registerWorkerCommand(program);
registerEventsCommand(program);
registerLogsCommand(program);
installCliOperationalLogging(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  // Commander hooks cannot observe a rejected action; leave a best-effort
  // process-level record before preserving the original failure semantics.
  // Guarded so a *secondary* failure here (e.g. the DB itself is what's
  // broken) can never replace or mask the original error rethrown below.
  try {
    const { getDb } = await import('../db/client.js');
    const { tryRecordOperationalLog } = await import('../db/repositories/operational-logs.js');
    // Carries the duration of whichever action was in flight, so a slow
    // failure (a timeout, the case most worth measuring) is timed even
    // though Commander's postAction hook never runs for a rejection.
    const inFlight = takeRunningAction();
    tryRecordOperationalLog(getDb(), {
      severity: 'error',
      outcome: 'failed',
      component: 'cli',
      action: inFlight ? `${inFlight.command} (unhandled)` : 'unhandled-action',
      error,
      durationMs: inFlight?.durationMs ?? null,
    });
  } catch {
    // best-effort only — the original error below is what matters.
  }
  throw error;
}
