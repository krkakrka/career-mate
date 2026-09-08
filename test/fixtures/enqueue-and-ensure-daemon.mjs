// Mimics what a future CLI command will do once real job producers exist:
// enqueue a job, then ensure the daemon is running to pick it up. Run as its
// own process (via spawn, with CM_DATA_DIR set in its env) so it — and the
// daemon it spawns, which inherits that env — never touch the real project
// .data/ directory.
import { register } from 'tsx/esm/api';

register();

const { getDb, closeDb } = await import('../../src/db/client.ts');
const { enqueueJob } = await import('../../src/db/repositories/jobs.ts');
const { ensureDaemonRunning } = await import('../../src/lib/daemon-control.ts');

const db = getDb();
const job = enqueueJob(db, {
  topic: 'notification',
  payload: {
    entityType: 'role',
    entityId: null,
    eventType: 'test.event',
    message: 'test notification from enqueue-and-ensure-daemon fixture',
  },
});
console.log(`enqueued job #${job.id}`);

ensureDaemonRunning();
closeDb();
