#!/usr/bin/env node
// Starts a real daemon, then throws a non-Error from outside any job — the
// shape of failure that used to kill the daemon silently, leaving a stale
// pid file that made `ensureDaemonRunning` believe one was still alive.
import { register } from 'tsx/esm/api';

register();
await import('../../src/daemon/index.ts');

setTimeout(() => {
  // Deliberately not an Error: the logging path has to survive a thrown
  // string, which is what a careless `throw` in a handler produces.
  throw 'daemon exploded';
}, 500);
