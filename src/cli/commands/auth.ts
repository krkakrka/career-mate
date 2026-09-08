import type { Command } from 'commander';
import { notImplemented } from '../not-implemented.js';

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Manage session reuse for login-gated sources');

  auth
    .command('login-browser')
    .description('Open a browser against the dedicated automation profile so you can log in once')
    .action(notImplemented('auth login-browser'));
}
