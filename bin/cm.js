#!/usr/bin/env node
import { register } from 'tsx/esm/api';

const unregister = register();
try {
  await import('../src/cli/index.ts');
} finally {
  unregister();
}
