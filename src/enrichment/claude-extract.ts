import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadSettings } from '../config/settings.js';
import { sanitizeOperationalValue } from '../db/repositories/operational-logs.js';
import { getDataDir } from '../lib/paths.js';

/** Enough of a failure to diagnose it, bounded so a runaway stderr can't land in the job's error column. */
const STDERR_TAIL_LENGTH = 300;

export class ExtractionError extends Error {
  /**
   * What the call cost, when that is knowable.
   *
   * A call can fail *after* the model has answered and billed — an envelope
   * reporting `is_error`, or an answer that isn't the JSON we asked for.
   * Carrying usage out with the error is what stops those failures being
   * invisible to the spend ledger, which would otherwise understate by
   * exactly the calls that went wrong and then got retried.
   */
  readonly usage: ExtractionUsage | undefined;

  constructor(message: string, usage?: ExtractionUsage) {
    super(message);
    this.name = 'ExtractionError';
    this.usage = usage;
  }
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
}

interface ClaudeResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
}

/** What a call cost and who answered it — recorded on the `derivations` row beside the value it produced. */
export interface ExtractionUsage {
  model: string | null;
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ExtractionResult {
  /** The model's answer, parsed. Always a JSON object — never an array or primitive. */
  data: unknown;
  usage: ExtractionUsage;
}

/**
 * Which model actually answered, from `modelUsage`.
 *
 * A single call lists more than one model — a research call routinely shows
 * both `claude-haiku-4-5` and `claude-sonnet-5`, one of them doing a small
 * ancillary task. Attribution is by **cost**, not token count, because a
 * measured example had it exactly backwards: haiku 1023 in / 14 out for
 * $0.0011, sonnet 2 in / 101 out for $0.0270. The token heuristic picked
 * haiku and recorded 96% of the money against the wrong model; the
 * expensive one is the one that did the work.
 *
 * Token count is the fallback for an envelope that omits per-model cost.
 */
function readModel(envelope: ClaudeResultEnvelope): string | null {
  const entries = Object.entries(envelope.modelUsage ?? {});
  if (entries.length === 0) return null;

  const weight = ([, usage]: [string, ClaudeModelUsage]): number =>
    typeof usage?.costUSD === 'number'
      ? usage.costUSD
      : ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)) / 1e9;
  return entries.reduce((busiest, entry) => (weight(entry) > weight(busiest) ? entry : busiest))[0];
}

function readUsage(envelope: ClaudeResultEnvelope): ExtractionUsage {
  return {
    model: readModel(envelope),
    costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : 0,
    inputTokens: typeof envelope.usage?.input_tokens === 'number' ? envelope.usage.input_tokens : null,
    outputTokens: typeof envelope.usage?.output_tokens === 'number' ? envelope.usage.output_tokens : null,
  };
}

/**
 * Runs a `claude -p ... --output-format json` script, piping `stdinContent`
 * in, and returns the raw stdout. Uses async spawn (not spawnSync) — a
 * claude -p call can take several seconds, and spawnSync would block the
 * whole Node process, freezing every other concurrent job slot and the
 * notification handler along with it.
 */
/**
 * An empty directory to run `claude` in.
 *
 * The model is handed untrusted page content, and `--tools ""` confines the
 * file tools to the working directory — so the working directory should
 * contain nothing. Running in the project root (the default) would put the
 * source tree and `.data/` inside that boundary.
 */
function scratchDir(): string {
  const dir = path.join(getDataDir(), 'tmp', 'claude-scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Kills the child and anything it spawned. `detached: true` gives the child
 * its own process group, so a negative pid signals the whole group; if it
 * has already exited, killing the group throws ESRCH, which is the outcome
 * we wanted anyway.
 */
/**
 * Every `claude` child currently running.
 *
 * `detached: true` puts each in its own process group, which is what lets
 * the timeout kill a whole tree — but it also means a terminal SIGINT no
 * longer reaches them, and the daemon's SIGTERM handler exits without
 * waiting. An orphaned `claude` keeps running and keeps spending up to
 * --max-budget-usd, with the timer that would have killed it gone along
 * with its parent. `killRunningExtractions` is what shutdown calls.
 */
const liveChildren = new Set<ChildProcess>();

/** Kills every in-flight `claude` call. Called on daemon shutdown; safe to call when there are none. */
export function killRunningExtractions(): void {
  for (const child of liveChildren) killTree(child);
  liveChildren.clear();
}

function killTree(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Keeps the useful tail of a failure without letting page content or
 * credentials into storage.
 *
 * Sanitize first, then truncate — the redaction patterns key off a
 * `Bearer `/`token=` prefix, so cutting first can remove the prefix and
 * leave the secret's tail looking like ordinary text. Same order
 * `sanitizeOperationalError` uses.
 */
function stderrTail(stderr: string): string {
  const safe = String(sanitizeOperationalValue(stderr.trim()));
  return safe.slice(-STDERR_TAIL_LENGTH);
}

function runScript(scriptPath: string, args: string[], stdinContent: string): Promise<string> {
  const settings = loadSettings();
  const timeoutMs = Math.max(1, settings.claude_timeout_seconds) * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: scratchDir(),
      env: { ...process.env, CM_MAX_BUDGET_USD: String(settings.claude_max_budget_usd) },
      // Its own process group, so the timeout below can kill the whole tree.
      // The scripts `exec` claude, so usually the child *is* claude — but a
      // script that spawned a helper would otherwise leave it running,
      // holding the stdout pipe open.
      detached: true,
    });

    // Decode as a stream, not chunk by chunk: a multi-byte character
    // straddling a 64KB pipe boundary would otherwise decode as two U+FFFD
    // replacements. Job descriptions are full of é, —, • and emoji, and
    // deriveText deliberately preserves them, so this lands as mojibake in
    // roles.description rather than as an error.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    liveChildren.add(child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      outcome();
    };

    /**
     * A hung model call would otherwise hold an enrichment worker forever —
     * concurrency is 1, so one stuck job stops every other enrichment.
     *
     * The rejection happens here rather than waiting for `close`, because
     * `close` may never arrive: killing the child does not kill a grandchild
     * that inherited the stdout pipe, and node holds the stream open until
     * every writer is gone. Killing the process group handles the common
     * case; settling here is what guarantees the worker is released either
     * way.
     */
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish(() =>
        reject(
          new ExtractionError(
            `Extraction command timed out after ${settings.claude_timeout_seconds}s and was killed`,
          ),
        ),
      );
    }, timeoutMs);

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => finish(() => reject(error)));

    // Without this, a child that exits before reading its stdin (a bad
    // flag, a missing binary) makes the write below raise an unhandled
    // EPIPE — which takes the whole daemon down, not just the job.
    child.stdin.on('error', () => {
      /* the close handler below reports the real reason */
    });

    child.on('close', (code) => {
      // A timeout has already rejected; anything arriving now is the corpse.
      if (timedOut) return;
      finish(() => {
        if (code !== 0) {
          // stdout can contain private page content, so it is never
          // included; the stderr tail is sanitized. Before this, every
          // failure read "exited with code 1" and said nothing about why.
          const detail = stderrTail(stderr);
          reject(
            new ExtractionError(
              `Extraction command exited with code ${code}${detail ? `: ${detail}` : ''}`,
            ),
          );
          return;
        }
        resolve(stdout);
      });
    });

    child.stdin.write(stdinContent);
    child.stdin.end();
  });
}

/**
 * claude -p sometimes wraps its JSON answer in a ```json ... ``` fence
 * despite being told not to (confirmed empirically: identical prompts
 * produced both fenced and unfenced output across runs) — strip it if
 * present rather than assume either way.
 */
function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1]! : trimmed;
}

/**
 * Runs a claude -p extraction script and returns the model's answer parsed
 * as JSON. Handles the double-JSON shape of `--output-format json`: the
 * outer envelope wraps claude's own text response, which is itself
 * (usually) a JSON string.
 */
export async function runExtraction(
  scriptPath: string,
  args: string[],
  stdinContent: string,
): Promise<ExtractionResult> {
  const stdout = await runScript(scriptPath, args, stdinContent);

  let envelope: ClaudeResultEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeResultEnvelope;
  } catch {
    throw new ExtractionError('claude -p did not return a valid JSON envelope');
  }

  const usage = readUsage(envelope);

  if (envelope.is_error || typeof envelope.result !== 'string') {
    throw new ExtractionError('claude -p reported an error', usage);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFence(envelope.result));
  } catch {
    throw new ExtractionError("claude -p's answer was not valid JSON", usage);
  }

  // Every extraction prompt asks for a JSON *object* with specific fields.
  // A bare `null`/array/primitive is valid JSON but not that shape — better
  // to fail clearly here than have a caller's `.name`/`.title` access throw
  // a confusing TypeError two frames away from where the real problem is.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ExtractionError("claude -p's answer was not a JSON object", usage);
  }

  return { data: parsed, usage };
}
