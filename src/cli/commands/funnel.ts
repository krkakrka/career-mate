import type { Command } from 'commander';
import { parsePositiveInt } from '../parsers.js';
import { loadSettings } from '../../config/settings.js';
import { getDb } from '../../db/client.js';
import {
  buildFunnel,
  type AttentionItem,
  type Funnel,
} from '../../reporting/funnel.js';

const REASON_LABEL: Record<AttentionItem['reason'], string> = {
  'closed-not-triaged': 'CLOSED',
  'recruiter-overdue': 'FOLLOW UP',
  'reapply-ready': 'REAPPLY',
  stale: 'STALE',
};

function describe(item: { title: string | null; company: string | null; roleId: number }): string {
  const name = item.title ?? '(untitled)';
  return item.company ? `${name} at ${item.company} (#${item.roleId})` : `${name} (#${item.roleId})`;
}

/** `cm discover` bulk-creates `new` roles, so an uncapped board would scroll the actionable panel off screen. */
const MAX_PER_STAGE = 8;

function printBoard(funnel: Funnel): void {
  const active = funnel.stages.filter((stage) => !stage.terminal);
  const terminal = funnel.stages.filter((stage) => stage.terminal);

  console.log('Pipeline\n');
  for (const stage of active) {
    console.log(`  ${stage.status.padEnd(13)} ${String(stage.opportunities.length).padStart(3)}`);
    for (const opportunity of stage.opportunities.slice(0, MAX_PER_STAGE)) {
      console.log(`      ${describe(opportunity)}`);
    }
    const hidden = stage.opportunities.length - MAX_PER_STAGE;
    if (hidden > 0) console.log(`      …and ${hidden} more — \`cm roles list --status ${stage.status}\``);
  }

  const closedCounts = terminal
    .map((stage) => `${stage.status} ${stage.opportunities.length}`)
    .join('  ·  ');
  console.log(`\n  closed out:   ${closedCounts}`);
}

function printAttention(funnel: Funnel, limit = Number.POSITIVE_INFINITY): void {
  if (funnel.needsAttention.length === 0) {
    console.log(
      funnel.totalActive === 0
        ? '\nNothing tracked yet. Add something with `cm roles add <url>`.'
        : '\nNothing needs attention right now.',
    );
    return;
  }

  console.log(`\nNeeds attention (${funnel.needsAttention.length})\n`);
  for (const item of funnel.needsAttention.slice(0, limit)) {
    console.log(`  ${REASON_LABEL[item.reason].padEnd(10)} ${describe(item)}`);
    console.log(`             ${item.detail}`);
  }
  if (funnel.needsAttention.length > limit) {
    // Not "see `cm`" — that shows fewer, and re-running the command you
    // just ran reproduces the identical truncated list.
    console.log(`\n  …and ${funnel.needsAttention.length - limit} more — \`cm next --limit ${funnel.needsAttention.length}\``);
  }
}

export function registerFunnelCommands(program: Command): void {
  program
    .command('next')
    .description('What needs your attention right now, most costly to ignore first')
    .option('--limit <n>', 'Show at most this many items', parsePositiveInt, 10)
    .action((opts: { limit: number }) => {
      const funnel = buildFunnel(getDb(), loadSettings());
      printAttention(funnel, opts.limit);
    });

  program
    .command('board', { isDefault: true, hidden: true })
    .description('Show the opportunity funnel (also what `cm` with no arguments shows)')
    // Commander routes anything it does not recognise to the default
    // command, so without this a typo like `cm rolez list` failed with
    // "too many arguments for 'board'" — naming a hidden command that does
    // not appear in --help.
    .argument('[unrecognized...]', 'internal: captures a mistyped command so it can be reported properly')
    .action((unrecognized: string[]) => {
      if (unrecognized.length > 0) {
        console.error(`error: unknown command '${unrecognized[0]}'`);
        console.error('Run `cm --help` to see the available commands.');
        process.exitCode = 1;
        return;
      }
      // The default action, so bare `cm` opens on the work rather than on a
      // help screen. Discovering the tool by reading `--help` was the thing
      // that made it feel unusable; the board names the vocabulary
      // (opportunities, stages) while showing the state.
      const funnel = buildFunnel(getDb(), loadSettings());
      printBoard(funnel);
      printAttention(funnel, 5);
      console.log('\n  `cm next` for the full list  ·  `cm --help` for every command');
    });
}
