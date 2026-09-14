-- Which surface caused the spend, recorded on the ledger row itself.
--
-- Step 26 attributed spend by joining `model_calls.job_id` to `jobs.origin`.
-- That join is a liability the moment anything deletes a job: the foreign
-- key is `ON DELETE SET NULL`, so pruning completed jobs would silently
-- move historical spend into "unattributed" and quietly rewrite the answer
-- to "is the agent worth it" — with nothing to indicate it had happened.
--
-- `model_calls` is an append-only ledger of money already spent, and a
-- ledger that depends on another table still being there is not one. The
-- origin is denormalised here at write time instead, which also removes the
-- join from the report.
--
-- Backfilled from `jobs` for rows whose job still exists; NULL elsewhere,
-- which is what an unrecorded origin has always meant.
ALTER TABLE model_calls ADD COLUMN origin TEXT;

UPDATE model_calls
   SET origin = (SELECT j.origin FROM jobs j WHERE j.id = model_calls.job_id)
 WHERE job_id IS NOT NULL;
