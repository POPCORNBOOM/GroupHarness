import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
      settings: {
        model: { apikey: string; model: string };
        filePermission: { default: string };
        workingDirectory: string;
        im: { host: string; port: number };
        webui: { accent: string; background: string; foreground: string };
        configPath: string;
      };
    };
    assert.equal(initial.group.id, 'demo');
    assert.equal(initial.group.name, 'Demo');
    assert.equal(initial.permissionIds.length, 6);
    assert.ok(initial.businessTools.includes('read_file'));
    assert.match(initial.im, /^ws:\/\//);
    assert.equal(initial.settings.webui.accent, '#6ea8fe');
    assert.equal(initial.settings.webui.background, '#0d0f12');
    assert.equal(initial.settings.webui.foreground, '#d7dae0');
    assert.equal(initial.settings.model.apikey.includes('sk-test-secret-value'), false);
    assert.match(initial.settings.model.apikey, /sk-.*alue/);
    assert.equal((await fetch(base + '/api/settings')).status, 401);
    assert.equal((await fetch(base + '/api/settings', withToken())).status, 200);
    assert.equal((await fetch(base + '/api/tools?group=demo')).status, 401);
    const toolsPage = (await (
      await fetch(base + '/api/tools?group=demo', withToken())
    ).json()) as { tools: { name: string; async: boolean }[] };
    assert.ok(toolsPage.tools.some((tool) => tool.name === 'read_file'));
    assert.ok(toolsPage.tools.some((tool) => tool.name === 'run_command_async' && tool.async));

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

    const updated = await fetch(
      base + '/api/settings',
      withToken({
        method: 'PUT',
        body: JSON.stringify({
          patch: {
            model: { model: 'global-model', context_window: 64000 },
            filePermission: { read: ['/tmp/allowed'] },
            workingDirectory: 'settings-work',
            webui: { accent: '#112233', background: '#010203', foreground: '#aabbcc' },
          },
        }),
      }),
    );
    assert.equal(updated.status, 200);
    const settings = (await (await fetch(base + '/api/settings', withToken())).json()) as {
      model: { model: string; context_window: number; apikey: string };
      filePermission: { read: string[] };
      workingDirectory: string;
      webui: { accent: string; background: string; foreground: string };
    };
    assert.equal(settings.model.model, 'global-model');
    assert.equal(settings.model.context_window, 64000);
    assert.deepEqual(settings.filePermission.read, ['/tmp/allowed']);
    assert.equal(settings.workingDirectory, join(root, 'settings-work'));
    assert.deepEqual(settings.webui, { accent: '#112233', background: '#010203', foreground: '#aabbcc' });
    assert.equal(JSON.stringify(settings).includes('sk-test-secret-value'), false);
    const configText = readFileSync(join(root, '.groupharness', 'config.toml'), 'utf8');
    assert.match(configText, /model = "global-model"/);
    assert.match(configText, /accent = "#112233"/);
    assert.match(configText, /apikey = "sk-test-secret-value"/);
    assert.equal(
      (await fetch(
        base + '/api/settings',
        withToken({ method: 'PUT', body: JSON.stringify({ patch: { webui: { accent: 'red' } } }) }),
      )).status,
      400,
    );
    assert.equal(
      (await fetch(
        base + '/api/settings',
        withToken({ method: 'PUT', body: JSON.stringify({ patch: { nope: true } }) }),
      )).status,
      400,
    );

    const permission = await fetch(
      base + '/api/permissions',
      withToken({
        method: 'PUT',
        body: JSON.stringify({ group: 'demo', permission: 'manage_group', groups: ['core'] }),
      }),
    );
    assert.equal(permission.status, 200);

    const contextPath = harness.requireGroup('demo').contextPath('bob');
    writeFileSync(
      contextPath,
      [
        JSON.stringify({ role: 'user', content: 'one' }),
        JSON.stringify({ role: 'assistant', content: 'two' }),
        JSON.stringify({ role: 'user', content: 'three' }),
        '',
      ].join('\n'),
      'utf8',
    );
    assert.equal((await fetch(base + '/api/context?group=demo&agent=bob')).status, 401);
    const contextPage = (await (
      await fetch(base + '/api/context?group=demo&agent=bob&limit=2', withToken())
    ).json()) as {
      messages: { role: string; content: string }[];
      before: number;
      after: number;
      size: number;
      hasMore: boolean;
    };
    assert.deepEqual(contextPage.messages.map((message) => message.content), ['two', 'three']);
    assert.equal(contextPage.hasMore, true);
    assert.ok(contextPage.before > 0);
    assert.equal(contextPage.after, contextPage.size);
    const olderPage = (await (
      await fetch(base + '/api/context?group=demo&agent=bob&before=' + contextPage.before, withToken())
    ).json()) as { messages: { content: string }[]; hasMore: boolean };
    assert.deepEqual(olderPage.messages.map((message) => message.content), ['one']);
    assert.equal(olderPage.hasMore, false);
    writeFileSync(contextPath, JSON.stringify({ role: 'tool', content: 'four' }) + '\n', { flag: 'a' });
    const deltaPage = (await (
      await fetch(base + '/api/context?group=demo&agent=bob&after=' + contextPage.after, withToken())
    ).json()) as { messages: { content: string }[]; after: number; size: number };
    assert.deepEqual(deltaPage.messages.map((message) => message.content), ['four']);
    assert.equal(deltaPage.after, deltaPage.size);
    assert.equal(
      (await fetch(base + '/api/context?group=demo&agent=alice', withToken())).status,
      400,
    );
    assert.equal(
      (await fetch(base + '/api/context?group=demo&agent=bob&before=1&after=1', withToken())).status,
      400,
    );

    const sent = await fetch(
      base + '/api/messages',
      withToken({
        method: 'POST',
        body: JSON.stringify({ group: 'demo', user: 'alice', text: '@bob admin sends this' }),
      }),
    );
    assert.equal(sent.status, 200);
    const sentBody = (await sent.json()) as { ok: boolean; id: number };
    assert.equal(sentBody.ok, true);
    assert.ok(sentBody.id > 0);
    const afterSend = (await (await fetch(base + '/api/state?group=demo', withToken())).json()) as {
      group: { messages: { id: number; sender_id: string; source: string; text: string }[] };
    };
    const sentMessage = afterSend.group.messages.find((entry) => entry.id === sentBody.id);
    assert.equal(sentMessage?.sender_id, 'alice');
    assert.equal(sentMessage?.source, 'web-admin');
    assert.equal(sentMessage?.text, '@bob admin sends this');

    const group = harness.requireGroup('demo');
    const secondId = group.send('alice', 'page two', 'user_message', 'test');
    const thirdId = group.send('alice', 'page three', 'user_message', 'test');
    const messagePage = (await (
      await fetch(base + '/api/messages?group=demo&limit=2', withToken())
    ).json()) as {
      messages: { id: number; text: string }[];
      before: number;
      after: number;
      hasMore: boolean;
    };
    assert.deepEqual(messagePage.messages.map((message) => message.text), ['page two', 'page three']);
    assert.equal(messagePage.after, thirdId);
    assert.equal(messagePage.hasMore, true);
    const olderMessages = (await (
      await fetch(base + '/api/messages?group=demo&before=' + messagePage.before + '&limit=2', withToken())
    ).json()) as { messages: { text: string }[]; hasMore: boolean };
    assert.ok(olderMessages.messages.some((message) => message.text === '@bob admin sends this'));
    assert.equal(olderMessages.hasMore, false);
    const deltaMessages = (await (
      await fetch(base + '/api/messages?group=demo&after=' + sentBody.id + '&limit=2', withToken())
    ).json()) as { messages: { id: number; text: string }[] };
    assert.deepEqual(deltaMessages.messages.map((message) => message.id), [secondId, thirdId]);
    assert.equal((await fetch(base + '/api/messages?group=demo', withToken({ headers: { 'x-admin-token': 'wrong' } }))).status, 401);
    assert.equal(
      (await fetch(base + '/api/messages?group=demo&before=1&after=1', withToken())).status,
      400,
    );
    assert.equal(
      (await fetch(
        base + '/api/messages',
        withToken({ method: 'POST', body: JSON.stringify({ group: 'demo', user: 'bob', text: 'nope' }) }),
      )).status,
      400,
    );
    assert.equal(
      (await fetch(
        base + '/api/messages',
        withToken({ method: 'POST', body: JSON.stringify({ group: 'demo', user: 'alice', text: '  ' }) }),
      )).status,
      400,
    );

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
    assert.match(audit, /"action":"set_settings"/);
    assert.match(audit, /"action":"send_as_user"/);
    assert.equal(audit.includes('sk-web-secret'), false);
    assert.equal(audit.includes('sk-test-secret-value'), false);
  } finally {
    await harness.close();
  }
});
