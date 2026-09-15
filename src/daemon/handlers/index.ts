import type Database from 'better-sqlite3';
import type { JobTopic } from '../../domain/job-topic.js';
import type { JobHandler } from '../worker-pool.js';
import { handleDiscoveryJob } from './discover.js';
import { handleEnrichmentJob } from './enrichment.js';
import { handleNotificationJob } from './notification.js';
import { handleRefreshJob } from './refresh.js';
import { handleTipsJob } from './tips.js';

export function buildHandlerRegistry(db: Database.Database): Partial<Record<JobTopic, JobHandler>> {
  return {
    notification: (job) => handleNotificationJob(db, job),
    enrichment: (job) => handleEnrichmentJob(db, job),
    tips: (job) => handleTipsJob(db, job),
    refresh: (job) => handleRefreshJob(db, job),
    discovery: (job) => handleDiscoveryJob(db, job),
  };
}

export const DEFAULT_TOPIC_CONCURRENCY: Record<JobTopic, number> = {
  // enrichment: nothing in this topic touches Playwright any more — the
  // shared-browser constraint that originally set this to 1 went with the
  // login-gated WLB source in Step 40. It stays at 1 because enrichment is
  // where the money is: every slot is a `claude -p` call with web search,
  // and serialising them keeps one `cm discover` run's follow-up work from
  // spending several budgets at once. Raise it deliberately, not by
  // inheriting a reason that no longer applies.
  enrichment: 1,
  // tips: a single ad-hoc user-invoked command, so there is nothing to
  // parallelise.
  tips: 1,
  notification: 3,
  refresh: 1,
  discovery: 1,
};
