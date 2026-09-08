import { Command } from 'commander';
import { registerCompaniesCommand } from './commands/companies.js';
import { registerRolesCommand } from './commands/roles.js';
import { registerRecruitersCommand, registerInterviewNoteCommand } from './commands/recruiters.js';
import { registerTipsCommand } from './commands/tips.js';
import { registerRefreshCommand } from './commands/refresh.js';
import { registerDiscoverCommand } from './commands/discover.js';
import { registerStatusCommand } from './commands/status.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerDaemonCommand } from './commands/daemon.js';
import { registerWorkerCommand } from './commands/worker.js';
import { registerEventsCommand } from './commands/events.js';

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

await program.parseAsync(process.argv);
