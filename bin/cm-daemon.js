#!/usr/bin/env node
import { register } from 'tsx/esm/api';

// Unlike bin/cm.js, this process is long-running (it stays alive polling
// for jobs), so there's no "runs once and exits" argument for skipping
// unregister — but there's still nothing to unregister until shutdown,
// which src/daemon/index.ts's SIGTERM/SIGINT handlers own.
register();
await import('../src/daemon/index.ts');
