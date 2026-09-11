import { spawn } from 'node:child_process';

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, unknown>;
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
 * `modelUsage` is keyed by model id, so its first key names the model that
 * actually answered — more trustworthy than assuming a default, since the
 * `claude` CLI may route a request elsewhere.
 */
function readUsage(envelope: ClaudeResultEnvelope): ExtractionUsage {
  const modelIds = envelope.modelUsage ? Object.keys(envelope.modelUsage) : [];
  return {
    model: modelIds[0] ?? null,
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
function runScript(scriptPath: string, args: string[], stdinContent: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        // stdout/stderr can contain private page content or credentials.
        reject(new ExtractionError(`Extraction command exited with code ${code}`));
        return;
      }
      resolve(stdout);
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

  if (envelope.is_error || typeof envelope.result !== 'string') {
    throw new ExtractionError('claude -p reported an error');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFence(envelope.result));
  } catch {
    throw new ExtractionError("claude -p's answer was not valid JSON");
  }

  // Every extraction prompt asks for a JSON *object* with specific fields.
  // A bare `null`/array/primitive is valid JSON but not that shape — better
  // to fail clearly here than have a caller's `.name`/`.title` access throw
  // a confusing TypeError two frames away from where the real problem is.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ExtractionError("claude -p's answer was not a JSON object");
  }

  return { data: parsed, usage: readUsage(envelope) };
}
