import type { Command } from 'commander';
import { parseExtractionOutput, runExtractionRaw } from '../../enrichment/claude-extract.js';
import { captureDir, readExtractionBundle } from '../../enrichment/extraction-capture.js';
import { InvalidArgumentError } from 'commander';
import { parsePositiveInt } from '../parsers.js';

/**
 * Each replay of a real bundle can spend up to `--max-budget-usd`, so a
 * stray extra zero on `--repeat` turns a debugging run into real money. The
 * cap is a guardrail against the typo, not a limit anyone should hit
 * deliberately.
 */
const MAX_REPEAT = 50;

function parseRepeat(value: string): number {
  const parsed = parsePositiveInt(value);
  if (parsed > MAX_REPEAT) {
    throw new InvalidArgumentError(`--repeat is capped at ${MAX_REPEAT} (each run can cost real money)`);
  }
  return parsed;
}

/**
 * Re-runs a captured extraction failure against the real (or fake) `claude`
 * binary and reports, across N repeats, whether the garbage is
 * deterministic.
 *
 * This is the payoff of the capture bundle: a durable log records *that* an
 * extraction failed, but only the bundle carries the exact inputs — and
 * only replaying them tells you whether the model reliably returns garbage
 * for this input (a prompt/parser problem, fixable and lockable) or does so
 * intermittently (a model-quality problem for evals and retry policy).
 *
 * It runs the same code path production does: `runExtractionRaw` invokes the
 * same script with the same flags via `CM_CLAUDE_BIN`, so what you see here
 * is what the daemon saw.
 */
export function registerDebugCommand(program: Command): void {
  const debug = program.command('debug').description('Diagnostics for reproducing extraction failures');

  debug
    .command('replay-extraction <bundle>')
    .description('Re-run a captured extraction bundle and show each raw model answer')
    .option('--repeat <count>', `How many times to re-run (default 1, max ${MAX_REPEAT})`, parseRepeat)
    .option('--parse', 'Also attempt to parse each answer and report the outcome')
    .action(async (bundlePath: string, opts: { repeat?: number; parse?: boolean }) => {
      const bundle = readExtractionBundle(bundlePath);
      const repeat = opts.repeat ?? 1;

      console.log(`# replaying ${bundlePath}`);
      console.log(`#   script: ${bundle.scriptPath}`);
      console.log(`#   args:   ${JSON.stringify(bundle.args)}`);
      console.log(`#   stdin:  ${bundle.stdinContent.length} bytes`);
      if (bundle.error) console.log(`#   original error: ${bundle.error}`);
      console.log(`#   repeats: ${repeat}\n`);

      // Kept apart on purpose: a run that never produced output (timeout,
      // missing binary, non-zero exit) is an infra/transient failure, not
      // the model returning bad output — conflating them would let a run of
      // timeouts read as "deterministic bad output", the opposite verdict.
      let parsedOk = 0;
      let parseFailed = 0;
      let runErrors = 0;
      for (let attempt = 1; attempt <= repeat; attempt++) {
        console.log(`--- attempt ${attempt}/${repeat} ---`);
        let raw: string;
        try {
          raw = await runExtractionRaw(bundle.scriptPath, bundle.args, bundle.stdinContent);
        } catch (error) {
          runErrors++;
          console.log(`run failed: ${error instanceof Error ? error.message : String(error)}\n`);
          continue;
        }

        // The raw envelope is the garbage under investigation — print it
        // verbatim so the model's actual output is visible.
        console.log(raw.trimEnd());

        if (opts.parse) {
          try {
            const { data } = parseExtractionOutput(raw);
            parsedOk++;
            console.log(`\nparsed OK: ${JSON.stringify(data)}`);
          } catch (error) {
            parseFailed++;
            console.log(`\nparse FAILED: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        console.log('');
      }

      if (opts.parse) {
        // The verdict the whole exercise exists to produce.
        console.log(
          `# verdict: ${parsedOk}/${repeat} parsed OK, ${parseFailed}/${repeat} bad output, ${runErrors}/${repeat} run errors`,
        );
        if (runErrors === repeat) {
          console.log('# every attempt errored before producing output — likely transient/infra, not the model');
        } else if (parseFailed > 0 && parsedOk > 0) {
          console.log('# intermittent — model output is non-deterministic for this input');
        } else if (parsedOk === 0) {
          console.log('# deterministic failure — this input reliably produces bad output');
        } else if (parsedOk === repeat) {
          console.log('# no failure reproduced — the original may have been transient');
        }
      }
    });

  debug
    .command('list-failures')
    .description('Show the directory where captured extraction bundles are written')
    .action(() => {
      console.log(captureDir());
      console.log('Set CM_DEBUG_EXTRACTION=1 to have failed extractions write bundles here.');
    });
}
