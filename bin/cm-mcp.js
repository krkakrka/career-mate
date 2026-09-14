#!/usr/bin/env node
import { register } from 'tsx/esm/api';

// Long-running like the daemon, so nothing to unregister until exit.
register();
await import('../src/mcp/index.ts');
