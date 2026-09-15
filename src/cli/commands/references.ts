import path from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';
import { getDb } from '../../db/client.js';
import { NotFoundError } from '../../db/errors.js';
import { getRoleById } from '../../db/repositories/roles.js';
import {
  createRoleReference,
  deleteRoleReference,
  listRoleReferences,
  REFERENCE_TYPES,
  type ReferenceType,
} from '../../db/repositories/role-references.js';
import { ReferenceFileError, resolveReferencePath, storeReferenceFile } from '../../references/store.js';
import { reportKnownErrors } from '../handle-known-errors.js';
import { parsePositiveInt } from '../parsers.js';

const KNOWN_ERRORS = [NotFoundError, ReferenceFileError];

/**
 * `InvalidArgumentError`, not a plain Error — the convention every parser in
 * `parsers.ts` follows. Commander renders this one as a usage message; a
 * plain Error escapes as a stack trace for a simple typo.
 */
function parseReferenceType(value: string): ReferenceType {
  if (!(REFERENCE_TYPES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Expected one of ${REFERENCE_TYPES.join(', ')}, got "${value}"`);
  }
  return value as ReferenceType;
}

export function printRoleReferences(db: ReturnType<typeof getDb>, roleId: number): void {
  const references = listRoleReferences(db, roleId);
  if (references.length === 0) return;
  console.log(`Attachments: ${references.length}`);
  for (const reference of references) {
    const notes = reference.notes ? `  — ${reference.notes}` : '';
    console.log(`  #${reference.id} [${reference.type}] ${path.basename(reference.file_path)}  ${reference.created_at}${notes}`);
  }
}

export function registerReferencesCommand(program: Command): void {
  const references = program.command('references').description('Attach files to a role: CVs, cover letters, answers you sent');

  references
    .command('add')
    .description('Copy a file into career-mate and attach it to a role')
    .argument('<role-id>', 'Role id', parsePositiveInt)
    .requiredOption('--file <path>', 'The file to attach (copied; your original is left where it is)')
    .option('--type <type>', `One of: ${REFERENCE_TYPES.join(', ')}`, parseReferenceType, 'other' as ReferenceType)
    .option('--notes <text>', 'What this is, or why you sent it')
    .action((roleId: number, opts: { file: string; type: ReferenceType; notes?: string }) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        if (!getRoleById(db, roleId)) throw new NotFoundError(`No role #${roleId}`);

        // The copy happens before the row: a row pointing at a file that
        // was never written is worse than a file with no row, which is
        // merely untidy.
        const stored = storeReferenceFile(roleId, opts.file);
        const reference = createRoleReference(db, {
          roleId,
          type: opts.type,
          filePath: stored.relativePath,
          notes: opts.notes ?? null,
        });

        console.log(`Attached #${reference.id} [${reference.type}] to role #${roleId}`);
        console.log(`  copied to ${stored.absolutePath}`);
        console.log(`  your original is untouched at ${path.resolve(opts.file)}`);
      });
    });

  references
    .command('list')
    .description('List the files attached to a role')
    .argument('<role-id>', 'Role id', parsePositiveInt)
    .action((roleId: number) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        if (!getRoleById(db, roleId)) throw new NotFoundError(`No role #${roleId}`);

        const list = listRoleReferences(db, roleId);
        if (list.length === 0) {
          console.log(`No files attached to role #${roleId}.`);
          return;
        }
        for (const reference of list) {
          console.log(`#${reference.id}  [${reference.type}]  ${reference.created_at}`);
          console.log(`  ${resolveReferencePath(reference.file_path)}`);
          if (reference.notes) console.log(`  ${reference.notes}`);
        }
      });
    });

  references
    .command('rm')
    .description("Remove an attachment and career-mate's copy of the file")
    .argument('<id>', 'Reference id', parsePositiveInt)
    .action((id: number) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const { reference, fileRemoved } = deleteRoleReference(getDb(), id);
        // Said explicitly, because "removed" could reasonably be read as
        // having deleted the file you attached — and the copy's removal is
        // reported, not asserted, since it can fail on a read-only volume.
        console.log(
          fileRemoved
            ? `Removed #${reference.id} and career-mate's copy.`
            : `Removed #${reference.id}, but could not delete career-mate's copy at ${resolveReferencePath(reference.file_path)}.`,
        );
        console.log('Your original file was never touched.');
      });
    });
}
