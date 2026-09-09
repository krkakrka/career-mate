import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { NotFoundError } from '../../db/errors.js';
import { createInterviewNote } from '../../db/repositories/interview-notes.js';
import { getRoleById } from '../../db/repositories/roles.js';
import { reportKnownErrors } from '../handle-known-errors.js';
import { parsePositiveInt } from '../parsers.js';

const KNOWN_ERRORS = [NotFoundError];

export function registerInterviewNoteCommand(program: Command): void {
  const interviewNote = program.command('interview-note').description('Track interview retro notes');

  interviewNote
    .command('add')
    .description('Add a retro note for an interview stage')
    .argument('<roleId>', 'Role id', parsePositiveInt)
    .requiredOption('--stage <stage>', 'Interview stage (phone screen, onsite, ...)')
    .requiredOption('--notes <notes>', 'What happened / what was asked')
    .action((roleId: number, options: { stage: string; notes: string }) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        if (!getRoleById(db, roleId)) throw new NotFoundError(`Role #${roleId} not found`);
        const note = createInterviewNote(db, { roleId, stage: options.stage, notes: options.notes });
        console.log(`Added interview note #${note.id} for role #${roleId}`);
      });
    });
}
