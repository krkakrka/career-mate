import type Database from 'better-sqlite3';
import type { JobTopic } from '../../domain/job-topic.js';
import type { JobHandler } from '../worker-pool.js';
import { handleEnrichmentJob } from './enrichment.js';
import { handleNotificationJob } from './notification.js';

/**
 * The live handler registry. Topics with no entry here (refresh, discovery,
 * tips as of this step) are simply not drained yet — nothing enqueues jobs
 * for them until the step that builds their producer.
 */
export function buildHandlerRegistry(db: Database.Database): Partial<Record<JobTopic, JobHandler>> {
  return {
    notification: (job) => handleNotificationJob(db, job),
    enrichment: (job) => handleEnrichmentJob(db, job),
  };
}

export const DEFAULT_TOPIC_CONCURRENCY: Record<JobTopic, number> = {
  // Playwright/Chrome-bound — only one real browser to share.
  enrichment: 1,
  tips: 1,
  notification: 3,
  refresh: 1,
  discovery: 1,
};
