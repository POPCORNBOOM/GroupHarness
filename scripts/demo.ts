/**
 * End-to-end demo with the real model: alice chats over the mock IM, bob reads a
 * file, starts a background task, and the task result arrives on the separate
 * result channel. Run: npm run demo
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Harness } from '../src/harness';
import { saveAgentConfigLayer } from '../src/config';
import { emptyGroupMeta, saveGroupMeta } from '../src/meta';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional; the environment may already provide the values.
}

const repoRoot = process.cwd();
const apiKey = process.env.API_KEY ?? '';
const model = process.env.MODEL ?? '';
const baseurl = process.env.BASE_URL ?? 'https://api.commandcode.ai/provider/v1';
// Do not hand the API key to tools through the inherited process environment.
delete process.env.API_KEY;
delete process.env.MODEL;
delete process.env.BASE_URL;
if (apiKey === '' || model === '') {
  console.error('missing API_KEY or MODEL (put them in .env or export them)');
  process.exit(1);
}

const demoRoot = join(repoRoot, '.demo');
rmSync(demoRoot, { recursive: true, force: true });
Harness.init(demoRoot, { apikey: apiKey, model, baseurl });
const configPath = join(demoRoot, '.groupharness', 'config.toml');
writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('port = 8787', 'port = 8899'));

const groupDir = join(demoRoot, '.groupharness', 'groups', 'demo');
mkdirSync(groupDir, { recursive: true });
const meta = emptyGroupMeta('Group Harness Demo');
meta.admins = ['alice'];
meta.members = [
  { id: 'alice', type: 'user' },
  { id: 'bob', type: 'agent' },
];
meta.identity_groups = { core: ['alice'] };
meta.permissions = { manage_group: ['core'] };
meta.policies = [{ agent: 'bob', trigger_mode: 'mention', sender_type: 'user', context_before: 6 }];
meta.working_directory = repoRoot;
saveGroupMeta(join(groupDir, 'meta.toml'), meta);
saveAgentConfigLayer(join(groupDir, 'agents', 'bob', 'config.toml'), {
  tools: ['read_file', 'run_command_async'],
});

const harness = await Harness.open({ rootDir: demoRoot, runtime: true, im: true, deliverRestart: false });
console.log('group harness demo');
console.log('  project:', demoRoot);
console.log('  im: ws://127.0.0.1:' + String(harness.imPort));

const socket = new WebSocket('ws://127.0.0.1:' + String(harness.imPort));
const agentMessages: string[] = [];
const taskResults: { status: string; stdout: string }[] = [];
let hello = false;

socket.on('message', (data) => {
  const frame = JSON.parse(data.toString()) as {
    type: string;
    message?: { sender_id: string; text: string };
    task?: { status: string; result?: { stdout?: string } };
  };
  if (frame.type === 'hello_ok') {
    hello = true;
    return;
  }
  if (frame.type === 'message' && frame.message !== undefined) {
    console.log('  ' + frame.message.sender_id + '> ' + frame.message.text.replaceAll('\n', '\n    '));
    if (frame.message.sender_id === 'bob') agentMessages.push(frame.message.text);
    return;
  }
  if (frame.type === 'task_result' && frame.task !== undefined) {
    const stdout = frame.task.result?.stdout ?? '';
    taskResults.push({ status: frame.task.status, stdout });
    console.log('  task_result> status=' + frame.task.status + ' stdout=' + stdout.trim());
  }
});

await new Promise<void>((resolve, reject) => {
  socket.once('open', () => resolve());
  socket.once('error', reject);
});
socket.send(
  JSON.stringify({
    type: 'hello',
    group_id: 'demo',
    user_id: 'alice',
  }),
);
const helloDeadline = Date.now() + 5_000;
while (!hello) {
  if (Date.now() > helloDeadline) throw new Error('mock IM never acknowledged hello');
  await sleep(20);
}

const prompt =
  '@bob Run the acceptance demo:\n' +
  '1. Call read_file on "package.json" and note its version.\n' +
  '2. Call run_command_async with command "sleep 1; echo async-ok", listeners ["alice"], visibility "private".\n' +
  '3. Call send_message once with "version=<version>; task started".\n' +
  'Use only those tools.';
console.log('  alice> ' + prompt.replaceAll('\n', '\n    '));
socket.send(JSON.stringify({ type: 'send', text: prompt }));

const deadline = Date.now() + 90_000;
let lastReport = Date.now();
while (Date.now() < deadline && (agentMessages.length === 0 || taskResults.length === 0)) {
  if (Date.now() - lastReport > 15_000) {
    lastReport = Date.now();
    console.log('  ... waiting (agentMessages=' + agentMessages.length + ', taskResults=' + taskResults.length + ')');
  }
  await sleep(250);
}
await sleep(2_000);

await harness.waitIdle(10_000);
const tasks = harness.requireGroup('demo').adminTasks(10);
socket.close();
await harness.close();

if (agentMessages.length === 0) {
  console.error('demo failed: the agent never sent a message');
  process.exit(1);
}
if (taskResults.length === 0 || taskResults[0]?.status !== 'done' || !taskResults[0].stdout.includes('async-ok')) {
  console.error('demo failed: no successful background task result on the channel');
  process.exit(1);
}
console.log('  tasks:', JSON.stringify(tasks));
console.log('demo complete: chat reply + background task result on the independent channel');
