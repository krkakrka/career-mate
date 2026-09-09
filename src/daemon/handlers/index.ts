import type Database from 'better-sqlite3';
import type { JobTopic } from '../../domain/job-topic.js';
import type { JobHandler } from '../worker-pool.js';
import { handleEnrichmentJob } from './enrichment.js';
import { handleNotificationJob } from './notification.js';
import { handleTipsJob } from './tips.js';

/**
 * The live handler registry. Topics with no entry here (refresh, discovery
 * as of this step) are simply not drained yet — nothing enqueues jobs for
 * them until the step that builds their producer.
 */
export function buildHandlerRegistry(db: Database.Database): Partial<Record<JobTopic, JobHandler>> {
  return {
    notification: (job) => handleNotificationJob(db, job),
    enrichment: (job) => handleEnrichmentJob(db, job),
    tips: (job) => handleTipsJob(db, job),
  };
}

export const DEFAULT_TOPIC_CONCURRENCY: Record<JobTopic, number> = {
  // enrichment: only company-wlb within this topic actually touches
  // Playwright/Chrome (one real shared browser); the rest (structural
  // fetch, role/company research) doesn't strictly need concurrency=1, but
  // splitting Playwright-bound work into its own topic is a bigger change
  // than this default warrants right now (see the step 8 commit message).
  enrichment: 1,
  // tips: no Playwright involved at all — concurrency=1 here is just
  // because it's a single ad-hoc user-invoked command, not a shared-browser constraint.
  tips: 1,
  notification: 3,
  refresh: 1,
  discovery: 1,
};
