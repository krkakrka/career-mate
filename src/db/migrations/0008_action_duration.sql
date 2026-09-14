-- How long an action took.
--
-- `model_calls` already records what the model cost in tokens and dollars,
-- but nothing recorded wall time — so "which command is slow", "is the
-- browser path the bottleneck", and "what does a conversation with the
-- agent actually cost me in time" were all unanswerable.
--
-- Null means "not measured": a `started` record has no duration yet, and
-- neither does a row written by a path that does not bracket its work.
ALTER TABLE operational_logs ADD COLUMN duration_ms INTEGER;

-- On a job this spans *one attempt* — claim to terminal state — so it
-- includes the model call and the fetch, but not the queue wait or earlier
-- retries' backoff (the enqueue/claim records answer those).
ALTER TABLE jobs ADD COLUMN duration_ms INTEGER;

-- When the current attempt was claimed.
--
-- `updated_at` cannot serve: it is re-stamped by every retry, requeue and
-- re-claim, so measuring from it reported only the last attempt — and in
-- the stale-requeue race (worker A runs 35 minutes, the sweep requeues,
-- worker B re-claims and re-stamps, A then completes) it reported roughly
-- zero for a 35-minute job.
ALTER TABLE jobs ADD COLUMN claimed_at TEXT;
