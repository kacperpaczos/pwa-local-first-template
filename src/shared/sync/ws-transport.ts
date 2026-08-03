import type { Conflict, PullResult, PushResult, SyncMutation, SyncTransport } from "./transport";
import { NoopSyncTransport } from "./noop-transport";
import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type ValidatedSyncMutation,
} from "./protocol";

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type WsSyncTransportOptions = {
  /** Inject a WebSocket constructor/factory (tests). Defaults to global WebSocket. */
  createSocket?: (url: string) => WebSocket;
  /** Per-request timeout in ms (tests can shorten). Default 10_000. */
  requestTimeoutMs?: number;
};

/**
 * Browser WebSocket transport talking to the Phase 2 relay.
 */
export class WsSyncTransport implements SyncTransport {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<
    string,
    {
      resolve: (message: ServerMessage) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly createSocket: (url: string) => WebSocket;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly url: string,
    options: WsSyncTransportOptions = {},
  ) {
    this.createSocket = options.createSocket ?? ((u) => new WebSocket(u));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async push(outbox: readonly SyncMutation[]): Promise<PushResult> {
    if (outbox.length === 0) {
      return { accepted: [], rejected: [] };
    }

    const requestId = createRequestId();
    const response = await this.request({
      type: "push",
      requestId,
      mutations: outbox as ValidatedSyncMutation[],
    });

    if (response.type !== "push_ack") {
      throw new Error(`Unexpected relay response: ${response.type}`);
    }

    return {
      accepted: response.accepted,
      rejected: response.rejected,
    };
  }

  async pull(cursor: string | null): Promise<PullResult> {
    const requestId = createRequestId();
    const response = await this.request({
      type: "pull",
      requestId,
      cursor,
    });

    if (response.type !== "pull_result") {
      throw new Error(`Unexpected relay response: ${response.type}`);
    }

    return {
      cursor: response.cursor,
      mutations: response.mutations,
    };
  }

  async resolve(_conflicts: readonly Conflict[]): Promise<void> {
    // Conflicts are resolved locally via LWW in apply-remote.
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Transport closed"));
    }
    this.pending.clear();
  }

  private async ensureConnected(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.socket;
    }

    if (!this.connecting) {
      this.connecting = new Promise<void>((resolve, reject) => {
        const socket = this.createSocket(this.url);
        this.socket = socket;

        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error(`Failed to connect to sync relay at ${this.url}`));
        };
        const cleanup = () => {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onError);
          this.connecting = null;
        };

        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", onError);
        socket.addEventListener("message", (event) => {
          this.onMessage(String(event.data));
        });
        socket.addEventListener("close", () => {
          this.socket = null;
        });
      });
    }

    await this.connecting;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Sync relay not connected: ${this.url}`);
    }
    return this.socket;
  }

  private onMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = parseServerMessage(JSON.parse(raw) as unknown);
    } catch {
      return;
    }

    if (message.type === "error") {
      if (message.requestId && this.pending.has(message.requestId)) {
        this.pending.get(message.requestId)?.reject(new Error(message.message));
        this.pending.delete(message.requestId);
      }
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(message.requestId);
    pending.resolve(message);
  }

  private async request(message: ClientMessage): Promise<ServerMessage> {
    const socket = await this.ensureConnected();
    const requestId = message.requestId;

    return new Promise<ServerMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Sync relay timeout for ${message.type}`));
      }, this.requestTimeoutMs);

      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      socket.send(JSON.stringify(message));
    });
  }
}

export function createSyncTransport(): SyncTransport {
  const configured = import.meta.env.VITE_SYNC_WS_URL as string | undefined;
  const url =
    configured && configured.length > 0
      ? configured
      : import.meta.env.DEV
        ? "ws://127.0.0.1:8787"
        : undefined;

  if (!url) {
    return new NoopSyncTransport();
  }
  return new WsSyncTransport(url);
}
