import type { Command } from 'commander';
import { getDb } from '../../db/client.js';
import { NotFoundError } from '../../db/errors.js';
import {
  createRecruiterContact,
  listRecruiterContacts,
  markRecruiterContactResponded,
  type RecruiterContact,
} from '../../db/repositories/recruiter-contacts.js';
import { getRoleById } from '../../db/repositories/roles.js';
import { loadSettings } from '../../config/settings.js';
import { reportKnownErrors } from '../handle-known-errors.js';
import { parsePositiveInt } from '../parsers.js';

const KNOWN_ERRORS = [NotFoundError];

function printContact(contact: RecruiterContact): void {
  console.log(`#${contact.id}  role=#${contact.role_id}  ${contact.recruiter_name}  contacted=${contact.contacted_at}`);
  if (contact.channel) console.log(`  channel: ${contact.channel}`);
  if (contact.link) console.log(`  link: ${contact.link}`);
  if (contact.notes) console.log(`  notes: ${contact.notes}`);
  if (contact.responded_at) console.log(`  responded: ${contact.responded_at}`);
}

export function registerRecruitersCommand(program: Command): void {
  const recruiters = program.command('recruiters').description('Track recruiter outreach');

  recruiters
    .command('ping')
    .description('Record that you contacted a recruiter about a role')
    .argument('<roleId>', 'Role id', parsePositiveInt)
    .requiredOption('--name <name>', 'Recruiter name')
    .option('--channel <channel>', 'How you contacted them (LinkedIn, email, ...)')
    .option('--link <link>', 'Link to the conversation')
    .option('--notes <notes>', 'Freeform notes')
    .action((roleId: number, options: { name: string; channel?: string; link?: string; notes?: string }) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        if (!getRoleById(db, roleId)) throw new NotFoundError(`Role #${roleId} not found`);
        const contact = createRecruiterContact(db, {
          roleId,
          recruiterName: options.name,
          channel: options.channel,
          link: options.link,
          notes: options.notes,
        });
        console.log(`Recorded recruiter contact #${contact.id} for role #${roleId}`);
      });
    });

  recruiters
    .command('respond')
    .description('Mark a recruiter contact as responded')
    .argument('<contactId>', 'Contact id', parsePositiveInt)
    .action((contactId: number) => {
      reportKnownErrors(KNOWN_ERRORS, () => {
        const db = getDb();
        const contact = markRecruiterContactResponded(db, contactId);
        if (!contact) throw new NotFoundError(`Recruiter contact #${contactId} not found`);
        printContact(contact);
      });
    });

  recruiters
    .command('list')
    .description('List recruiter contacts')
    .option('--role <id>', 'Filter by role id', parsePositiveInt)
    .option('--overdue', 'Only show contacts overdue for a follow-up')
    .action((options: { role?: number; overdue?: boolean }) => {
      const db = getDb();
      const contacts = listRecruiterContacts(db, {
        roleId: options.role,
        overdueDays: options.overdue ? loadSettings().recruiter_nudge_days : undefined,
      });
      if (contacts.length === 0) {
        console.log(options.overdue ? 'No overdue recruiter contacts.' : 'No recruiter contacts recorded.');
        return;
      }
      contacts.forEach(printContact);
    });
}
