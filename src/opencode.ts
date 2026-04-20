import { spawn, ChildProcess } from "node:child_process";
import net from "node:net";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { log } from "./log.js";

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

export interface OpencodeEvent {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  properties: any;
}

export type EventHandler = (event: OpencodeEvent) => void;

/**
 * One OpenCode server per project directory.
 * Holds the child process, the SDK client, and a fan-out event bus.
 */
export class OpencodeServer {
  private child?: ChildProcess;
  private port?: number;
  private clientInstance?: OpencodeClient;
  private handlers = new Set<EventHandler>();
  private eventAbort?: AbortController;
  private started = false;

  constructor(public readonly projectDir: string) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${this.port}`;

    log.info(`Starting opencode serve for ${this.projectDir} on :${this.port}`);
    this.child = spawn(
      "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", String(this.port)],
      {
        cwd: this.projectDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );

    this.child.stdout?.on("data", (b) => log.debug("[opencode]", b.toString().trim()));
    this.child.stderr?.on("data", (b) => log.debug("[opencode!]", b.toString().trim()));
    this.child.on("exit", (code) => {
      log.warn(`opencode serve exited (${code}) for ${this.projectDir}`);
      this.started = false;
    });

    await waitForHttp(`${baseUrl}/doc`, 15_000);
    this.clientInstance = createOpencodeClient({ baseUrl });
    this.started = true;
    this.pumpEvents().catch((err) => log.error("event pump crashed", err));
  }

  async stop(): Promise<void> {
    this.eventAbort?.abort();
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (!this.child) return resolve();
        const t = setTimeout(() => {
          this.child?.kill("SIGKILL");
          resolve();
        }, 3000);
        this.child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.started = false;
  }

  client(): OpencodeClient {
    if (!this.clientInstance) throw new Error("Opencode server not started");
    return this.clientInstance;
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private async pumpEvents(): Promise<void> {
    if (!this.port) return;
    this.eventAbort = new AbortController();
    const url = `http://127.0.0.1:${this.port}/event`;

    // The SDK exposes an event.subscribe helper, but its exact streaming shape
    // has shifted between versions. Falling back to raw SSE here is resilient.
    while (this.started) {
      try {
        const res = await fetch(url, { signal: this.eventAbort.signal });
        if (!res.body) throw new Error("no event stream body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            this.dispatch(parseSseFrame(frame));
          }
        }
      } catch (err) {
        if (this.eventAbort?.signal.aborted) return;
        log.warn("event stream disconnected, retrying in 2s:", String(err));
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private dispatch(event: OpencodeEvent | null): void {
    if (!event) return;
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        log.error("event handler threw", err);
      }
    }
  }
}

function parseSseFrame(frame: string): OpencodeEvent | null {
  const lines = frame.split("\n");
  let data = "";
  for (const line of lines) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as OpencodeEvent;
  } catch {
    return null;
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("Could not allocate port"));
      }
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}
