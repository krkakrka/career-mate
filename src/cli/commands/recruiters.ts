import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerRecruitersCommand(program: Command): void {
  const recruiters = program.command('recruiters').description('Track recruiter outreach');

  recruiters
    .command('ping <roleId>')
    .description('Record that you contacted a recruiter about a role')
    .requiredOption('--name <name>', 'Recruiter name')
    .option('--channel <channel>', 'How you contacted them (LinkedIn, email, ...)')
    .option('--link <link>', 'Link to the conversation')
    .option('--notes <notes>', 'Freeform notes')
    .action(notImplemented('recruiters ping'));

  recruiters
    .command('respond <contactId>')
    .description('Mark a recruiter contact as responded')
    .action(notImplemented('recruiters respond'));

  recruiters
    .command('list')
    .description('List recruiter contacts')
    .option('--overdue', 'Only show contacts overdue for a follow-up')
    .action(notImplemented('recruiters list'));
}
