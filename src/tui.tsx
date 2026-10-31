/**
 * Ink control console. It reads group state and runs administrative commands;
 * it is not a chat client — user messages arrive only through the mock IM.
 */
import { Box, Text, render, useApp, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { formatGroupView, runCommand, tokenize } from './commands';
import type { Harness } from './harness';

type Panel = 'overview' | 'messages' | 'tasks';

const PANELS: Panel[] = ['overview', 'messages', 'tasks'];
const LOG_KEEP = 200;
const PANEL_LINES = 22;

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

function shorten(text: string, max = 140): string {
  const single = text.replaceAll('\n', ' \\n ');
  return single.length <= max ? single : single.slice(0, max) + '…';
}

function panelContent(harness: Harness, groupId: string | undefined, panel: Panel): string[] {
  if (groupId === undefined) return ['No groups yet. Start with: create demo'];
  let group;
  try {
    group = harness.requireGroup(groupId);
  } catch (error) {
    return [(error as Error).message];
  }
  if (panel === 'overview') {
    try {
      return formatGroupView(group.view()).split('\n');
    } catch (error) {
      return [`config error: ${(error as Error).message}`];
    }
  }
  if (panel === 'messages') {
    const messages = group.latestMessages(PANEL_LINES);
    if (messages.length === 0) return ['no messages'];
    return messages.map((message) => `#${message.id} ${message.sender_id} [${message.kind}] ${shorten(message.text)}`);
  }
  const tasks = group.adminTasks(PANEL_LINES);
  if (tasks.length === 0) return ['no tasks'];
  return tasks.map(
    (task) =>
      `${task.taskId.slice(0, 8)} ${task.tooltype} [${task.status}] ${task.visibility} by ${task.publisherId}`,
  );
}

function App({ harness }: { harness: Harness }) {
  const app = useApp();
  const [tick, setTick] = useState(0);
  const groups = harness.listGroups();
  const [selected, setSelected] = useState<string | undefined>(groups[0]?.id);
  const [panel, setPanel] = useState<Panel>('overview');
  const [input, setInput] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  const lines = useMemo(() => {
    void tick;
    return panelContent(harness, selected, panel);
  }, [harness, selected, panel, tick]);

  const activeGroup = selected !== undefined ? groups.find((group) => group.id === selected) : undefined;

  const append = (text: string): void => {
    setLog((previous) => [...previous, ...splitLines(text)].slice(-LOG_KEEP));
  };

  const execute = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    append(`> ${trimmed}`);
    if (trimmed === 'quit' || trimmed === 'exit') {
      app.exit();
      return;
    }
    let tokens: string[];
    try {
      tokens = tokenize(trimmed);
    } catch (error) {
      append(`error: ${(error as Error).message}`);
      return;
    }
    const [command, ...args] = tokens;
    if (command === 'view') {
      const target = args[0];
      if (target !== 'overview' && target !== 'messages' && target !== 'tasks') {
        append('usage: view <overview|messages|tasks>');
      } else {
        setPanel(target);
        append(`view: ${target}`);
      }
      return;
    }
    if (command === 'select') {
      const target = args[0];
      if (target === undefined || !groups.some((group) => group.id === target)) {
        append('usage: select <group>');
      } else {
        setSelected(target);
        append(`selected ${target}`);
      }
      return;
    }
    setBusy(true);
    void runCommand(harness, trimmed)
      .then((output) => {
        append(output === '' ? 'ok' : output);
        if (command === 'create' && args[0] !== undefined) setSelected(args[0]);
        setTick((value) => value + 1);
      })
      .catch((error: unknown) => append(`error: ${(error as Error).message}`))
      .finally(() => setBusy(false));
  };

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      app.exit();
      return;
    }
    // A terminal sends \r for Return; a paste (or a test driver) may deliver a
    // whole line with \n in one chunk. Treat both as "submit this line".
    if (key.return || char.includes('\r') || char.includes('\n')) {
      const beforeNewline = char.split(/[\r\n]/)[0] ?? '';
      execute(input + beforeNewline);
      setInput('');
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }
    const printable = char.replace(/[\u0000-\u001f\u007f]/g, '');
    if (printable !== '' && !key.ctrl && !key.meta) {
      setInput((value) => value + printable);
    }
  });

  const logTail = log.slice(-8);
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          Group Harness
        </Text>
        <Text dimColor> {harness.rootDir}</Text>
        {harness.imPort !== undefined ? <Text dimColor> · im ws://127.0.0.1:{harness.imPort}</Text> : null}
      </Box>
      <Box>
        <Text dimColor>groups: </Text>
        <Text>{groups.length}</Text>
        <Text dimColor> · selected: </Text>
        <Text color="green">{activeGroup?.id ?? '(none)'}</Text>
        <Text dimColor> · {busy ? 'working…' : 'commands: view/select, help, quit'}</Text>
      </Box>
      <Box>
        {PANELS.map((name) => (
          <Text key={name} color={name === panel ? 'green' : undefined} dimColor={name !== panel}>
            [{name}] 
          </Text>
        ))}
      </Box>
      <Text>────────────────────────────────────────────────────────────</Text>
      {lines.slice(0, PANEL_LINES).map((line, index) => (
        <Text key={`${index}-${line}`} wrap="truncate">
          {line}
        </Text>
      ))}
      <Text>────────────────────────────────────────────────────────────</Text>
      {logTail.map((line, index) => (
        <Text key={`log-${index}-${line}`} dimColor wrap="truncate">
          {line}
        </Text>
      ))}
      <Box>
        <Text color="green">:{' '}</Text>
        <Text>{input}</Text>
        <Text color="green">█</Text>
      </Box>
    </Box>
  );
}

/** Render the console and resolve when the user exits. */
export async function runTui(harness: Harness): Promise<void> {
  const instance = render(<App harness={harness} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
