import type Database from 'better-sqlite3';
import type { DerivationKind } from '../db/repositories/derivations.js';
import { recordModelCall } from '../db/repositories/model-calls.js';
import type { EntityType } from '../domain/entity-type.js';
import { ExtractionError, runExtraction, type ExtractionResult } from './claude-extract.js';

export interface ExtractionTracking {
  entityType?: EntityType | null;
  entityId?: number | null;
  kind: DerivationKind;
  jobId?: number | null;
}

/**
 * Runs an extraction and records what it cost, whether or not it succeeded.
 *
 * Two things this gets right that recording spend alongside the derivation
 * did not:
 *
 * 1. **Failures are recorded.** A call that hits `--max-budget-usd` and
 *    exits non-zero has still spent up to the ceiling; one whose answer
 *    isn't the JSON we asked for has still been billed. The job then
 *    retries and pays again. Recording only successes understated the
 *    total by exactly the calls that cost the most.
 * 2. **It happens outside the caller's transaction.** Handlers apply their
 *    value and derivation in one transaction; a rollback there must not
 *    erase the record of money already spent, which cannot be un-spent.
 *
 * A call killed by the timeout, or one whose envelope never parsed, reports
 * no usage at all — there is genuinely nothing to record, so it is counted
 * as a call at zero cost rather than guessed at.
 */
export async function runTrackedExtraction(
  db: Database.Database,
  tracking: ExtractionTracking,
  scriptPath: string,
  args: string[],
  stdinContent: string,
): Promise<ExtractionResult> {
  try {
    const result = await runExtraction(scriptPath, args, stdinContent);
    record(db, tracking, result.usage.model, result.usage.costUsd, result.usage.inputTokens, result.usage.outputTokens);
    return result;
  } catch (error) {
    const usage = error instanceof ExtractionError ? error.usage : undefined;
    record(db, tracking, usage?.model ?? 'unknown', usage?.costUsd ?? 0, usage?.inputTokens, usage?.outputTokens);
    throw error;
  }
}

function record(
  db: Database.Database,
  tracking: ExtractionTracking,
  model: string | null,
  costUsd: number,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): void {
  // Never let bookkeeping replace the result — or the failure — it is
  // bookkeeping for.
  try {
    recordModelCall(db, {
      entityType: tracking.entityType,
      entityId: tracking.entityId,
      kind: tracking.kind,
      model: model ?? 'unknown',
      costUsd,
      inputTokens: inputTokens ?? null,
      outputTokens: outputTokens ?? null,
      jobId: tracking.jobId,
    });
  } catch {
    // best effort
  }
}
