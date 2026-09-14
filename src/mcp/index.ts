import { closeDb, getDb } from '../db/client.js';
import { tryRecordOperationalLog } from '../db/repositories/operational-logs.js';
import { serveStdio } from './server.js';
import { setProcessOrigin } from '../lib/origin.js';

// Jobs this process enqueues are caused by this surface; the worker
// overrides it per job so a chain keeps the origin that started it.
setProcessOrigin('mcp');

const db = getDb();
tryRecordOperationalLog(db, { outcome: 'started', component: 'mcp', action: 'serve' });

serveStdio(db, process.stdin, process.stdout);

// The host closes stdin to stop the server; there is no other shutdown signal.
process.stdin.on('end', () => {
  tryRecordOperationalLog(db, { outcome: 'succeeded', component: 'mcp', action: 'serve' });
  closeDb();
  process.exit(0);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    closeDb();
    process.exit(0);
  });
}
