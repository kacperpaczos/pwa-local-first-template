import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsSyncTransport } from "./ws-transport";
import type { ServerMessage } from "./protocol";

const OPEN = 1;

class FakeSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    queueMicrotask(() => {
      this.readyState = OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  respond(message: ServerMessage): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

describe("WsSyncTransport", () => {
  let sockets: FakeSocket[];

  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTransport(timeoutMs = 10_000): WsSyncTransport {
    return new WsSyncTransport("ws://fake", {
      requestTimeoutMs: timeoutMs,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
  }

  async function latestSocket(): Promise<FakeSocket> {
    await vi.waitFor(() => {
      expect(sockets.length).toBeGreaterThan(0);
      expect(sockets[0]?.readyState).toBe(OPEN);
    });
    return sockets[sockets.length - 1]!;
  }

  it("resolves push_ack", async () => {
    const transport = createTransport();
    const pushPromise = transport.push([
      {
        idempotencyKey: "k",
        entity: "notes",
        op: "upsert",
        payload: { id: "1" },
      },
    ]);

    const socket = await latestSocket();
    const sent = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.respond({
      type: "push_ack",
      requestId: sent.requestId,
      accepted: ["k"],
      rejected: [],
    });

    await expect(pushPromise).resolves.toEqual({ accepted: ["k"], rejected: [] });
  });

  it("resolves pull_result", async () => {
    const transport = createTransport();
    const pullPromise = transport.pull(null);
    const socket = await latestSocket();
    const sent = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.respond({
      type: "pull_result",
      requestId: sent.requestId,
      cursor: "0",
      mutations: [],
    });
    await expect(pullPromise).resolves.toEqual({ cursor: "0", mutations: [] });
  });

  it("times out when the relay never answers", async () => {
    const transport = createTransport(50);
    const pullPromise = transport.pull("1");
    await latestSocket();
    const assertion = expect(pullPromise).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it("rejects pending requests on error with matching requestId", async () => {
    const transport = createTransport();
    const pullPromise = transport.pull(null);
    const socket = await latestSocket();
    const sent = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.respond({ type: "error", requestId: sent.requestId, message: "boom" });
    await expect(pullPromise).rejects.toThrow("boom");
  });

  it("rejects pending requests when closed", async () => {
    const transport = createTransport();
    const pullPromise = transport.pull(null);
    await latestSocket();
    await transport.close();
    await expect(pullPromise).rejects.toThrow(/closed/);
  });
});
