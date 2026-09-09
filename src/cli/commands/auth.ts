import type { Command } from 'commander';
import { withPersistentBrowser } from '../../browser/profile.js';

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Manage session reuse for login-gated sources');

  auth
    .command('login-browser')
    .description('Open a browser against the dedicated automation profile so you can log in once')
    .action(async () => {
      console.log('Opening a browser window. Log into whatever sites you need (Glassdoor, etc.), then close the window when done — the session will be reused for future headless fetches.');
      await withPersistentBrowser(
        async (context) => {
          const page = context.pages()[0] ?? (await context.newPage());
          await page.goto('https://www.glassdoor.com/index.htm');
          await new Promise<void>((resolve) => {
            context.on('close', () => resolve());
          });
        },
        { headless: false },
      );
      console.log('Browser closed. Session saved.');
    });
}
