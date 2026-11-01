/**
 * Local mock IM: one WebSocket port, one member transport per user. A member's
 * channel exists even while its socket is offline, so deliveries are held in a
 * small outbox and flushed on the next hello instead of blocking startup.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Group, UserTransport } from './group';
import type { StoredMessage } from './storage';
import type { TaskDetail } from './tools';

interface WireMessage {
  id: number;
  sender_id: string;
  kind: string;
  text: string;
  created_at: string;
}

interface WireTaskResult {
  taskId: string;
  tooltype: string;
  status: string;
  visibility: string;
  publisherId: string;
  listeners: string[];
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const OUTBOX_LIMIT = 100;

function wireMessage(message: StoredMessage): WireMessage {
  return {
    id: message.id,
    sender_id: message.sender_id,
    kind: message.kind,
    text: message.text,
    created_at: message.created_at,
  };
}

function wireTaskResult(task: TaskDetail): WireTaskResult {
  return {
    taskId: task.taskId,
    tooltype: task.tooltype,
    status: task.status,
    visibility: task.visibility,
    publisherId: task.publisherId,
    listeners: task.listeners,
    result: task.result,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

class UserChannel implements UserTransport {
  private socket?: WebSocket;
  private outbox: string[] = [];

  constructor(
    readonly groupId: string,
    readonly userId: string,
  ) {}

  bind(socket: WebSocket): void {
    if (this.socket !== undefined && this.socket !== socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'error', message: 'replaced by a newer connection' }));
      this.socket.close();
    }
    this.socket = socket;
    for (const line of this.outbox.splice(0)) {
      socket.send(line);
    }
  }

  unbind(socket: WebSocket): void {
    if (this.socket === socket) this.socket = undefined;
  }

  sendMessage(message: StoredMessage): void {
    this.push(JSON.stringify({ type: 'message', message: wireMessage(message) }));
  }

  sendTaskResult(task: TaskDetail): void {
    this.push(JSON.stringify({ type: 'task_result', task: wireTaskResult(task) }));
  }

  private push(line: string): void {
    if (this.socket !== undefined && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(line);
      return;
    }
    this.outbox.push(line);
    if (this.outbox.length > OUTBOX_LIMIT) this.outbox.shift();
  }
}

export interface ImServerOptions {
  host: string;
  port: number;
  groups: () => Group[];
  /** Optional HTTP handler served from the same port as the mock IM. */
  httpHandler?: (request: IncomingMessage, response: ServerResponse) => void;
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

export class ImServer {
  private server?: WebSocketServer;
  private httpServer?: Server;
  private readonly channels = new Map<string, UserChannel>();
  private readonly sockets = new Set<WebSocket>();

  constructor(private readonly options: ImServerOptions) {}

  get port(): number {
    const address = this.httpServer?.address();
    return typeof address === 'object' && address !== null ? address.port : this.options.port;
  }

  async start(): Promise<void> {
    const httpServer = createServer((request, response) => {
      const handler = this.options.httpHandler;
      if (handler === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      try {
        handler(request, response);
      } catch (error) {
        console.error(`http: request failed: ${(error as Error).message}`);
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('internal error');
        } else {
          response.destroy();
        }
      }
    });
    const server = new WebSocketServer({ server: httpServer, maxPayload: 1024 * 1024 });
    try {
      await new Promise<void>((resolve, reject) => {
        const onHttpError = (error: Error): void => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onWsError = (error: Error): void => reject(error);
        const onListening = (): void => {
          httpServer.off('error', onHttpError);
          server.off('error', onWsError);
          resolve();
        };
        httpServer.once('error', onHttpError);
        server.once('error', onWsError);
        httpServer.once('listening', onListening);
        httpServer.listen(this.options.port, this.options.host);
      });
    } catch (error) {
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } catch {
        // The WebSocket server may not have reached the listening state.
      }
      await closeHttpServer(httpServer);
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(
          `mock IM port ${this.options.port} is already in use; stop the other Group Harness process or change [im].port`,
        );
      }
      throw error;
    }
    server.on('connection', (socket) => this.handleConnection(socket));
    server.on('error', (error) => console.error(`im: server error: ${error.message}`));
    httpServer.on('error', (error) => console.error(`http: server error: ${error.message}`));
    this.server = server;
    this.httpServer = httpServer;
    for (const group of this.options.groups()) this.registerGroup(group);
  }

  /** Attach a channel for every user member so offline deliveries are held. */
  registerGroup(group: Group): void {
    for (const member of group.view().members) {
      if (member.type !== 'user') continue;
      this.ensureChannel(group, member.id);
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.channels.clear();
    const server = this.server;
    const httpServer = this.httpServer;
    this.server = undefined;
    this.httpServer = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (httpServer !== undefined) {
      httpServer.closeIdleConnections();
      await closeHttpServer(httpServer);
    }
  }

  private channelKey(groupId: string, userId: string): string {
    return `${groupId}\u0000${userId}`;
  }

  private ensureChannel(group: Group, userId: string): UserChannel {
    const key = this.channelKey(group.id, userId);
    const existing = this.channels.get(key);
    if (existing !== undefined) return existing;
    const channel = new UserChannel(group.id, userId);
    this.channels.set(key, channel);
    group.attachTransport(userId, channel);
    return channel;
  }

  private findGroup(groupId: string): Group | undefined {
    return this.options.groups().find((group) => group.id === groupId);
  }

  private handleConnection(socket: WebSocket): void {
    this.sockets.add(socket);
    let bound: { group: Group; channel: UserChannel } | undefined;

    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString()) as unknown;
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
        return;
      }
      if (message === null || typeof message !== 'object') {
        socket.send(JSON.stringify({ type: 'error', message: 'message must be an object' }));
        return;
      }
      const record = message as Record<string, unknown>;
      if (record.type === 'hello') {
        if (bound !== undefined) {
          socket.send(JSON.stringify({ type: 'error', message: 'already bound' }));
          return;
        }
        const groupId = typeof record.group_id === 'string' ? record.group_id : '';
        const userId = typeof record.user_id === 'string' ? record.user_id : '';
        const group = this.findGroup(groupId);
        if (group === undefined) {
          socket.send(JSON.stringify({ type: 'error', message: `unknown group "${groupId}"` }));
          return;
        }
        if (group.memberType(userId) !== 'user') {
          socket.send(JSON.stringify({ type: 'error', message: `"${userId}" is not a user in "${groupId}"` }));
          return;
        }
        const channel = this.ensureChannel(group, userId);
        socket.send(
          JSON.stringify({ type: 'hello_ok', group_id: group.id, user_id: userId }),
        );
        channel.bind(socket);
        bound = { group, channel };
        return;
      }
      if (record.type === 'send') {
        if (bound === undefined) {
          socket.send(JSON.stringify({ type: 'error', message: 'send a hello first' }));
          return;
        }
        const text = typeof record.text === 'string' ? record.text : '';
        try {
          const id = bound.group.send(bound.channel.userId, text, 'user_message', `im:${bound.channel.userId}`);
          socket.send(JSON.stringify({ type: 'sent', message_id: id }));
        } catch (error) {
          socket.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
        }
        return;
      }
      socket.send(JSON.stringify({ type: 'error', message: `unknown message type "${String(record.type)}"` }));
    });

    socket.on('close', () => {
      this.sockets.delete(socket);
      if (bound !== undefined) bound.channel.unbind(socket);
    });
    socket.on('error', () => {
      // 'close' follows; nothing else to do for the mock transport.
    });
  }
}
