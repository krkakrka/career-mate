import { spawn } from 'node:child_process';

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

interface ClaudeResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
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
        reject(new ExtractionError(`${scriptPath} exited ${code}: ${stderr.slice(0, 2000) || stdout.slice(0, 2000)}`));
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
): Promise<unknown> {
  const stdout = await runScript(scriptPath, args, stdinContent);

  let envelope: ClaudeResultEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeResultEnvelope;
  } catch {
    throw new ExtractionError(`claude -p did not return valid JSON envelope: ${stdout.slice(0, 500)}`);
  }

  if (envelope.is_error || typeof envelope.result !== 'string') {
    throw new ExtractionError(`claude -p reported an error: ${envelope.result ?? JSON.stringify(envelope)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFence(envelope.result));
  } catch {
    throw new ExtractionError(`claude -p's answer was not valid JSON: ${envelope.result.slice(0, 500)}`);
  }

  // Every extraction prompt asks for a JSON *object* with specific fields.
  // A bare `null`/array/primitive is valid JSON but not that shape — better
  // to fail clearly here than have a caller's `.name`/`.title` access throw
  // a confusing TypeError two frames away from where the real problem is.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ExtractionError(`claude -p's answer was not a JSON object: ${envelope.result.slice(0, 500)}`);
  }

  return parsed;
}
