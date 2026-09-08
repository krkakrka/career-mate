// Standalone worker for concurrency tests: attempts to create one role
// against a shared DB file and reports success/failure, then exits.
import { register } from 'tsx/esm/api';

register();

const { openDb } = await import('../../src/db/client.ts');
const { createRole } = await import('../../src/db/repositories/roles.ts');

const [, , dbPath, companyIdArg, url] = process.argv;
const companyId = Number(companyIdArg);

const db = openDb(dbPath);
try {
  const role = createRole(db, { companyId, url });
  console.log(`created role #${role.id}`);
  db.close();
  process.exitCode = 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  db.close();
  process.exitCode = 1;
}
