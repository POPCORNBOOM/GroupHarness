/**
 * Entry point: `npm start` opens the control console; `npm run gh -- <cmd>`
 * runs one console command and exits; `npm run gh -- init` writes the starter
 * config.
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

function usage(): string {
  return `Group Harness

usage:
  npm start                     open the TUI console
  npm run gh -- <command>       run one console command
  npm run gh -- init            create .groupharness/config.toml

${HELP_TEXT}`;
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

  const tui = first === undefined || first === 'tui';
  const harness = await Harness.open({
    runtime: tui,
    im: tui,
    deliverRestart: tui,
  });
  try {
    if (tui) {
      await runTui(harness);
    } else {
      const output = await runCommand(harness, argv.join(' '));
      if (output !== '') console.log(output);
    }
  } finally {
    await harness.close();
  }
  // A model request may still be in flight after the shutdown budget; leaving a
  // TUI process alive would return the user to a hung terminal. The unref'd
  // timer does not delay a normal exit.
  if (tui) setTimeout(() => process.exit(0), 1_000).unref();
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof CommandError ? error.message : (error as Error).message}`);
  process.exitCode = 1;
});
