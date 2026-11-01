import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Harness } from '../src/harness';
import { demoMeta, makeRoot, writeFixture } from './helpers';

test('web admin serves the page, guards the API, and drives the same admin path', async () => {
  const root = makeRoot();
  writeFixture(root, {
    meta: demoMeta(),
    agentLayers: { bob: { tools: ['read_file'], working_directory: 'work' } },
    imPort: 0,
  });
  const harness = await Harness.open({ rootDir: root, runtime: false, im: true, webAdmin: true });
  const adminUrl = new URL(harness.adminUrl ?? '');
  const base = adminUrl.origin;
  const token = adminUrl.searchParams.get('token') ?? '';
  assert.ok(token.length > 20);
  assert.equal(harness.imPort! > 0, true);

  const withToken = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: {
      'x-admin-token': token,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });

  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Group Harness Admin/);
    assert.ok(html.includes('--accent') && html.includes('--bg') && html.includes('--fg'));
    assert.equal(html.includes('box-shadow'), false);
    assert.equal(/gradient/i.test(html), false);
    assert.match(html, /button, input, select, textarea \{[^}]*border: 1px solid var\(--fg\)/s);
    const radii = [...html.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1]?.trim());
    assert.ok(radii.length > 0 && radii.every((radius) => radius === '0' || radius === '0 !important'));
    const colors = new Set([...html.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toLowerCase()));
    assert.deepEqual([...colors].sort(), ['#0d0f12', '#6ea8fe', '#d7dae0']);

    assert.equal((await fetch(base + '/api/state')).status, 401);
    assert.equal((await fetch(base + '/api/state', withToken())).status, 200);
    const initial = (await (await fetch(base + '/api/state', withToken())).json()) as {
      group: { id: string; name: string; members: { id: string }[]; agents: { id: string; overrides: unknown }[] };
      permissionIds: string[];
      businessTools: string[];
      im: string;
    };
    assert.equal(initial.group.id, 'demo');
    assert.equal(initial.group.name, 'Demo');
    assert.equal(initial.permissionIds.length, 6);
    assert.ok(initial.businessTools.includes('read_file'));
    assert.match(initial.im, /^ws:\/\//);

    const added = await fetch(
      base + '/api/members',
      withToken({ method: 'POST', body: JSON.stringify({ group: 'demo', id: 'carol', type: 'user' }) }),
    );
    assert.equal(added.status, 200);
    const afterAdd = (await (await fetch(base + '/api/state', withToken())).json()) as {
      group: { members: { id: string }[] };
    };
    assert.ok(afterAdd.group.members.some((member) => member.id === 'carol'));

    const configured = await fetch(
      base + '/api/agent-config',
      withToken({
        method: 'PUT',
        body: JSON.stringify({ group: 'demo', agent: 'bob', patch: { model: { apikey: 'sk-web-secret' } } }),
      }),
    );
    assert.equal(configured.status, 200);
    const configuredState = await (await fetch(base + '/api/state?group=demo', withToken())).json();
    assert.equal(JSON.stringify(configuredState).includes('sk-web-secret'), false);
    assert.match(JSON.stringify(configuredState), /sk-.*cret/);

    const setNumeric = await fetch(
      base + '/api/agent-config',
      withToken({
        method: 'PUT',
        body: JSON.stringify({ group: 'demo', agent: 'bob', patch: { model: { context_window: 1234 } } }),
      }),
    );
    assert.equal(setNumeric.status, 200);
    const withNumeric = (await (await fetch(base + '/api/state?group=demo', withToken())).json()) as {
      group: { agents: { id: string; overrides: { model?: { context_window?: number } } }[] };
    };
    assert.equal(
      withNumeric.group.agents.find((agent) => agent.id === 'bob')?.overrides.model?.context_window,
      1234,
    );
    const clearNumeric = await fetch(
      base + '/api/agent-config',
      withToken({
        method: 'PUT',
        body: JSON.stringify({ group: 'demo', agent: 'bob', patch: { model: { context_window: 0 } } }),
      }),
    );
    assert.equal(clearNumeric.status, 200);
    const cleared = (await (await fetch(base + '/api/state?group=demo', withToken())).json()) as {
      group: { agents: { id: string; overrides: { model?: { context_window?: number } } }[] };
    };
    assert.equal(
      cleared.group.agents.find((agent) => agent.id === 'bob')?.overrides.model?.context_window,
      undefined,
    );

    const permission = await fetch(
      base + '/api/permissions',
      withToken({
        method: 'PUT',
        body: JSON.stringify({ group: 'demo', permission: 'manage_group', groups: ['core'] }),
      }),
    );
    assert.equal(permission.status, 200);

    const message = harness.requireGroup('demo').send('alice', 'web search hello', 'user_message', 'test');
    assert.ok(message > 0);
    const search = (await (await fetch(base + '/api/search?group=demo&q=hello', withToken())).json()) as {
      messages: { text: string }[];
    };
    assert.equal(search.messages[0]?.text, 'web search hello');

    assert.equal((await fetch(base + '/api/nope', withToken())).status, 404);
    assert.equal((await fetch(base + '/api/state', { headers: { 'x-admin-token': 'wrong' } })).status, 401);

    await harness.audit.close();
    const audit = readFileSync(root + '/.groupharness/audit.jsonl', 'utf8');
    assert.match(audit, /"actor":"web"/);
    assert.equal(audit.includes('sk-web-secret'), false);
  } finally {
    await harness.close();
  }
});
