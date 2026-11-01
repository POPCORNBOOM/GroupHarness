import { createHash } from 'node:crypto';
import type { ChatMessage } from './llm';
import { PROMPTS } from './prompts';
import type { QueueItem } from './storage';

export interface RenderedBlock {
  id: number;
  content: string;
}

export interface QueueTranslator {
  kind: string;
  translate(items: QueueItem[]): RenderedBlock[];
}

interface ChatLine {
  seq: number;
  sender_id: string;
  kind: string;
  text: string;
}

interface ChatPayload {
  trigger: ChatLine;
  history: ChatLine[];
  context_before: number;
}

interface TaskResultPayload {
  task_id: string;
  tooltype: string;
  status: string;
  publisher_id: string;
  result: unknown;
  error: string | null;
}

interface ChatRange {
  min: number;
  max: number;
  itemIds: number[];
}

function chatLines(item: QueueItem): { lines: ChatLine[]; triggerId: number } {
  const payload = item.payload as ChatPayload;
  return {
    lines: [...payload.history, payload.trigger],
    triggerId: payload.trigger.seq,
  };
}

const chatTranslator: QueueTranslator = {
  kind: 'chat',
  translate(items) {
    const lineMap = new Map<number, ChatLine>();
    const triggers = new Set<number>();
    const ranges: ChatRange[] = [];

    for (const item of items) {
      const { lines, triggerId } = chatLines(item);
      triggers.add(triggerId);
      const seqs = lines.map((line) => line.seq);
      const min = Math.min(...seqs);
      const max = Math.max(...seqs);
      ranges.push({ min, max, itemIds: [item.id] });
      for (const line of lines) lineMap.set(line.seq, line);
    }

    ranges.sort((a, b) => a.min - b.min);
    const merged: ChatRange[] = [];
    for (const range of ranges) {
      const current = merged[merged.length - 1];
      if (current !== undefined && range.min <= current.max + 1) {
        current.max = Math.max(current.max, range.max);
        current.itemIds.push(...range.itemIds);
      } else {
        merged.push({ ...range, itemIds: [...range.itemIds] });
      }
    }

    return merged
      .map((range): RenderedBlock | undefined => {
        const lines = [...lineMap.values()]
          .filter((line) => line.seq >= range.min && line.seq <= range.max)
          .sort((a, b) => a.seq - b.seq);
        if (lines.length === 0) return undefined;
        const body = lines.map((line) => {
          const text = `[${line.seq}]${line.sender_id}: ${line.text}`;
          return triggers.has(line.seq) ? `你在意的->${text}` : text;
        });
        return {
          id: Math.min(...range.itemIds),
          content: ['收到新消息，请查阅聊天记录', ...body].join('\n'),
        };
      })
      .filter((block): block is RenderedBlock => block !== undefined);
  },
};

const taskResultTranslator: QueueTranslator = {
  kind: 'task_result',
  translate(items) {
    return items.map((item) => {
      const payload = item.payload as TaskResultPayload;
      return {
        id: item.id,
        content: PROMPTS.taskResult({
          taskId: payload.task_id,
          tooltype: payload.tooltype,
          status: payload.status,
          publisherId: payload.publisher_id,
          result: payload.result,
          ...(payload.error === null || payload.error === undefined ? {} : { error: payload.error }),
        }),
      };
    });
  },
};

const restartTranslator: QueueTranslator = {
  kind: 'system_restart',
  translate(items) {
    return items.map((item) => ({ id: item.id, content: PROMPTS.restart() }));
  },
};

export function roundHash(items: QueueItem[]): string {
  return createHash('sha256')
    .update(items.map((item) => `${item.id}:${item.kind}`).join('|'))
    .digest('hex')
    .slice(0, 8);
}

export class QueueRenderer {
  private readonly translators = new Map<string, QueueTranslator>();

  constructor() {
    this.register(chatTranslator);
    this.register(taskResultTranslator);
    this.register(restartTranslator);
  }

  register(translator: QueueTranslator): void {
    this.translators.set(translator.kind, translator);
  }

  render(items: QueueItem[], hash = roundHash(items)): ChatMessage[] {
    const groups = new Map<string, QueueItem[]>();
    for (const item of items) {
      const group = groups.get(item.kind);
      if (group === undefined) groups.set(item.kind, [item]);
      else group.push(item);
    }

    const inputIds = new Set(items.map((item) => item.id));
    const blocks: RenderedBlock[] = [];
    for (const [kind, group] of groups) {
      const translator = this.translators.get(kind);
      if (translator === undefined) {
        for (const item of group) {
          blocks.push({
            id: item.id,
            content: `[未知事件] ${JSON.stringify(item.payload ?? item.kind)}`,
          });
        }
        continue;
      }
      for (const block of translator.translate(group)) {
        if (!inputIds.has(block.id)) {
          throw new Error(`translator "${kind}" returned id ${block.id} not present in the batch`);
        }
        blocks.push(block);
      }
    }

    blocks.sort((a, b) => a.id - b.id);
    return blocks.map((block) => ({
      role: 'user',
      content: `Round #${hash}\n${block.content}`,
    }));
  }
}
