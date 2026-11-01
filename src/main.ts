/**
 * Entry point.
 *
 * `npm start` starts the web admin console (and the mock IM + agent runtimes)
 * and prints a tokenized local URL. `npm run tui` keeps the terminal console.
 * `npm run gh -- <cmd>` runs one console command without starting the service.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Harness } from './harness';
import { CommandError, HELP_TEXT, runCommand } from './commands';
import { runTui } from './tui';

function loadDotEnv(): void {
  if (!existsSync('.env')) return;
  try {
    process.loadEnvFile('.env');
  } catch {
    // A malformed .env is not fatal; config.toml is the source of truth.
  }
}

function configPath(): string {
  return join(process.cwd(), '.groupharness', 'config.toml');
}

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function usage(): string {
  return `Group Harness

usage:
  npm start                     start the web admin + mock IM (prints a tokenized URL)
  npm run tui                   start the terminal console instead
  npm run gh -- <command>       run one console command without the service
  npm run gh -- init            create .groupharness/config.toml

${HELP_TEXT}`;
}

function waitForSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === 'init') {
    loadDotEnv();
    const seed = {
      ...(process.env.API_KEY === undefined ? {} : { apikey: process.env.API_KEY }),
      ...(process.env.MODEL === undefined ? {} : { model: process.env.MODEL }),
      ...(process.env.BASE_URL === undefined ? {} : { baseurl: process.env.BASE_URL }),
    };
    const result = Harness.init(process.cwd(), seed);
    if (result.created) {
      console.log(`created ${result.configPath}`);
      if (seed.apikey === undefined || seed.model === undefined) {
        console.log('set model.baseurl, model.apikey, and model.model in that file (or rerun with API_KEY/MODEL/BASE_URL in .env)');
      }
      console.log('next: npm run gh -- create demo');
    } else {
      console.log(`config already exists: ${result.configPath}`);
    }
    return;
  }

  if (first === 'help' && !existsSync(configPath())) {
    console.log(usage());
    return;
  }

  const web = first === undefined || first === 'web';
  const tui = first === 'tui';
  const interactive = web || tui;
  const harness = await Harness.open({
    runtime: interactive,
    im: interactive,
    webAdmin: web,
    deliverRestart: interactive,
  });
  try {
    if (web) {
      const adminUrl = harness.adminUrl;
      const port = harness.imPort;
      if (adminUrl === undefined || port === undefined) throw new Error('web admin did not start');
      const host = displayHost(harness.globalConfig().im.host);
      console.log(`Group Harness admin: ${adminUrl}`);
      console.log(`Mock IM: ws://${host}:${port}`);
      console.log('Press Ctrl-C to stop.');
      await waitForSignal();
    } else if (tui) {
      await runTui(harness);
    } else {
      const output = await runCommand(harness, argv.join(' '));
      if (output !== '') console.log(output);
    }
  } finally {
    await harness.close();
  }
  // A model request may still be in flight after the shutdown budget; the
  // unref'd timer does not delay a normal exit.
  if (interactive) setTimeout(() => process.exit(0), 1_000).unref();
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof CommandError ? error.message : (error as Error).message}`);
  process.exitCode = 1;
});
