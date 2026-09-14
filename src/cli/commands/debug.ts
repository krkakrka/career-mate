import type { Command } from 'commander';
import { parseExtractionOutput, runExtractionRaw } from '../../enrichment/claude-extract.js';
import { captureDir, readExtractionBundle } from '../../enrichment/extraction-capture.js';
import { parsePositiveInt } from '../parsers.js';

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
    .option('--repeat <count>', 'How many times to re-run (default 1)', parsePositiveInt)
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

      let ok = 0;
      let failed = 0;
      for (let attempt = 1; attempt <= repeat; attempt++) {
        console.log(`--- attempt ${attempt}/${repeat} ---`);
        let raw: string;
        try {
          raw = await runExtractionRaw(bundle.scriptPath, bundle.args, bundle.stdinContent);
        } catch (error) {
          failed++;
          console.log(`run failed: ${error instanceof Error ? error.message : String(error)}\n`);
          continue;
        }

        // The raw envelope is the garbage under investigation — print it
        // verbatim so the model's actual output is visible.
        console.log(raw.trimEnd());

        if (opts.parse) {
          try {
            const { data } = parseExtractionOutput(raw);
            ok++;
            console.log(`\nparsed OK: ${JSON.stringify(data)}`);
          } catch (error) {
            failed++;
            console.log(`\nparse FAILED: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        console.log('');
      }

      if (opts.parse) {
        // The verdict the whole exercise exists to produce.
        console.log(`# verdict: ${ok}/${repeat} parsed OK, ${failed}/${repeat} failed`);
        if (failed > 0 && ok > 0) console.log('# intermittent — model output is non-deterministic for this input');
        else if (failed === repeat) console.log('# deterministic failure — same input reliably produces bad output');
        else if (ok === repeat) console.log('# no failure reproduced — the original may have been transient');
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
