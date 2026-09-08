#!/usr/bin/env node
import { register } from 'tsx/esm/api';

// This process runs one command and exits — no need to unregister the loader
// hook (and doing so via `finally` was actually unreachable half the time,
// since Commander's default --help/--version handling calls process.exit()
// synchronously before the finally block could run).
register();
await import('../src/cli/index.ts');
