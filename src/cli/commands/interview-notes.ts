import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerInterviewNoteCommand(program: Command): void {
  const interviewNote = program.command('interview-note').description('Track interview retro notes');

  interviewNote
    .command('add <roleId>')
    .description('Add a retro note for an interview stage')
    .requiredOption('--stage <stage>', 'Interview stage (phone screen, onsite, ...)')
    .requiredOption('--notes <notes>', 'What happened / what was asked')
    .action(notImplemented('interview-note add'));
}
