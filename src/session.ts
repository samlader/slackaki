import type { WebClient } from "@slack/web-api";
import { OpencodeServer, OpencodeEvent } from "./opencode.js";
import { StreamingMessage } from "./streaming.js";
import {
  permissionPromptBlocks,
  permissionResolvedText,
} from "./blocks.js";
import { log } from "./log.js";
import { ProjectMapping } from "./config.js";
import { StateStore } from "./state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SdkResult<T> = { data?: T; error?: any; response?: Response };

interface ThreadContext {
  channelId: string;
  threadTs: string;
  sessionId: string;
  projectDir: string;
  stream?: StreamingMessage;
  streamTs?: string;
  assistantMessageId?: string;
  // partID → rendered text, in insertion order
  parts: Map<string, string>;
  // Set when the session was started with /background. On completion or when
  // a permission prompt appears, we ping this user (in-thread and via DM).
  backgroundUserId?: string;
}

interface ProjectRuntime {
  mapping: ProjectMapping;
  server: OpencodeServer;
  threadsBySession: Map<string, ThreadContext>;
  threadsByTs: Map<string, ThreadContext>;
  permissionToSession: Map<string, string>;
  // messageID → role, so we can filter out user-echoed parts
  messageRoles: Map<string, "user" | "assistant">;
}

/**
 * Owns the Slack-thread ↔ OpenCode-session mapping and routes events between
 * the two. One ProjectRuntime per mapped channel/project.
 */
export class SessionManager {
  private runtimes = new Map<string, ProjectRuntime>();
  private store = new StateStore();

  constructor(
    private web: WebClient,
    private projects: ProjectMapping[],
  ) {}

  projectForChannel(channelId: string): ProjectMapping | undefined {
    return this.projects.find((p) => p.channelId === channelId);
  }

  async getServer(mapping: ProjectMapping): Promise<OpencodeServer> {
    return (await this.runtime(mapping)).server;
  }

  async fireScheduled(
    mapping: ProjectMapping,
    prompt: string,
    userId: string,
    naturalLanguage: string,
  ): Promise<void> {
    const posted = await this.web.chat.postMessage({
      channel: mapping.channelId,
      text: `:alarm_clock: *Scheduled run* (\`${naturalLanguage}\`) by <@${userId}>\n${prompt}`,
    });
    if (!posted.ts) return;
    await this.handleUserMessage({
      mapping,
      channelId: mapping.channelId,
      messageTs: posted.ts,
      text: prompt,
      userId,
      background: true,
    });
  }

  async shutdown(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      await rt.server.stop();
    }
  }

  private async runtime(mapping: ProjectMapping): Promise<ProjectRuntime> {
    const existing = this.runtimes.get(mapping.channelId);
    if (existing) return existing;

    const server = new OpencodeServer(mapping.projectDir);
    await server.start();

    const rt: ProjectRuntime = {
      mapping,
      server,
      threadsBySession: new Map(),
      threadsByTs: new Map(),
      permissionToSession: new Map(),
      messageRoles: new Map(),
    };
    this.runtimes.set(mapping.channelId, rt);

    server.onEvent((ev) => this.onOpencodeEvent(rt, ev));
    return rt;
  }

  /**
   * Handle a user message in a mapped channel. Either starts a new session
   * (top-level message) or continues an existing one (reply in managed thread).
   */
  async handleUserMessage(args: {
    mapping: ProjectMapping;
    channelId: string;
    messageTs: string;
    threadTs?: string;
    text: string;
    userId: string;
    background?: boolean;
  }): Promise<void> {
    const rt = await this.runtime(args.mapping);
    const parentTs = args.threadTs ?? args.messageTs;
    let ctx = rt.threadsByTs.get(parentTs);

    if (!ctx) {
      // Either a new thread, or an existing thread whose in-memory ctx was
      // lost to a restart. Check the persisted state first.
      let sessionId = this.store.getSession(args.channelId, parentTs);

      if (!sessionId) {
        const created = await callOptional<SdkResult<{ id: string }>>(
          rt.server.client(),
          ["session", "create"],
          [{ body: { title: `#${args.mapping.channelName} · <@${args.userId}>` } }],
        );
        sessionId = created?.data?.id;
        if (!sessionId) {
          const detail = created?.error
            ? `\n\`\`\`${JSON.stringify(created.error, null, 2)}\`\`\``
            : "";
          log.error("session.create returned no id", created);
          await this.web.chat.postMessage({
            channel: args.channelId,
            thread_ts: parentTs,
            text: `:warning: Could not create OpenCode session.${detail}`,
          });
          return;
        }
        this.store.setSession(args.channelId, parentTs, sessionId);
      }

      ctx = {
        channelId: args.channelId,
        threadTs: parentTs,
        sessionId,
        projectDir: args.mapping.projectDir,
        parts: new Map(),
        backgroundUserId: args.background ? args.userId : undefined,
      };
      rt.threadsByTs.set(parentTs, ctx);
      rt.threadsBySession.set(sessionId, ctx);
    } else if (args.background && !ctx.backgroundUserId) {
      ctx.backgroundUserId = args.userId;
    }

    // Post a placeholder we'll edit as the response streams in.
    const placeholder = await this.web.chat.postMessage({
      channel: args.channelId,
      thread_ts: parentTs,
      text: "_(thinking…)_",
    });
    if (placeholder.ts) {
      ctx.streamTs = placeholder.ts;
      ctx.stream = new StreamingMessage(this.web, args.channelId, placeholder.ts);
      ctx.assistantMessageId = undefined;
      ctx.parts = new Map();
    }

    // Fire the prompt asynchronously — responses come back via SSE.
    try {
      await callOptional(
        rt.server.client(),
        ["session", "prompt"],
        [
          {
            path: { id: ctx.sessionId },
            body: {
              parts: [{ type: "text", text: args.text }],
            },
          },
        ],
      );
    } catch (err) {
      log.error("session.prompt failed", err);
      await ctx.stream?.finalize(`\n\n:warning: Prompt failed: ${String(err)}`);
    }
  }

  async abortActiveSession(channelId: string, threadTs: string): Promise<boolean> {
    const mapping = this.projectForChannel(channelId);
    if (!mapping) return false;
    const rt = this.runtimes.get(mapping.channelId);
    const ctx = rt?.threadsByTs.get(threadTs);
    if (!rt || !ctx) return false;
    try {
      await callOptional(rt.server.client(), ["session", "abort"], [{ path: { id: ctx.sessionId } }]);
      return true;
    } catch (err) {
      log.warn("abort failed", err);
      return false;
    }
  }

  async respondToPermission(args: {
    sessionId: string;
    permissionId: string;
    decision: "accept" | "accept-always" | "deny";
    userId: string;
    channel: string;
    messageTs: string;
  }): Promise<void> {
    const rt = [...this.runtimes.values()].find((r) => r.threadsBySession.has(args.sessionId));
    if (!rt) {
      log.warn("permission for unknown session", args.sessionId);
      return;
    }
    try {
      await callOptional(
        rt.server.client(),
        ["postSessionIdPermissionsPermissionId"],
        [
          {
            path: { id: args.sessionId, permissionID: args.permissionId },
            body: {
              response: args.decision !== "deny",
              remember: args.decision === "accept-always",
            },
          },
        ],
      );
    } catch (err) {
      log.warn("SDK permission call failed, falling back to raw HTTP:", err);
      await this.rawRespondPermission(rt, args);
    }
    await this.web.chat.update({
      channel: args.channel,
      ts: args.messageTs,
      text: permissionResolvedText(args.decision, args.userId),
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: permissionResolvedText(args.decision, args.userId) },
        },
      ],
    });
  }

  private async notifyBackgroundCompletion(ctx: ThreadContext): Promise<void> {
    const user = ctx.backgroundUserId;
    if (!user) return;
    try {
      await this.web.chat.postMessage({
        channel: ctx.channelId,
        thread_ts: ctx.threadTs,
        text: `<@${user}> background task finished.`,
      });
      const link = await this.permalink(ctx);
      await this.dm(user, `:white_check_mark: Your background task finished.${link ? ` ${link}` : ""}`);
    } catch (err) {
      log.warn("background completion notify failed", err);
    }
  }

  private async notifyBackgroundNeedsInput(ctx: ThreadContext, title: string): Promise<void> {
    const user = ctx.backgroundUserId;
    if (!user) return;
    try {
      const link = await this.permalink(ctx);
      await this.dm(user, `:hand: Background task needs input — *${title}*.${link ? ` ${link}` : ""}`);
    } catch (err) {
      log.warn("background input notify failed", err);
    }
  }

  private async permalink(ctx: ThreadContext): Promise<string | undefined> {
    try {
      const res = await this.web.chat.getPermalink({
        channel: ctx.channelId,
        message_ts: ctx.threadTs,
      });
      return res.permalink;
    } catch {
      return undefined;
    }
  }

  private async dm(userId: string, text: string): Promise<void> {
    const opened = await this.web.conversations.open({ users: userId });
    const channel = opened.channel?.id;
    if (!channel) return;
    await this.web.chat.postMessage({ channel, text });
  }

  private async rawRespondPermission(
    rt: ProjectRuntime,
    args: { sessionId: string; permissionId: string; decision: "accept" | "accept-always" | "deny" },
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseUrl = (rt.server.client() as any).request?.config?.baseUrl as string | undefined;
    if (!baseUrl) return;
    await fetch(
      `${baseUrl}/session/${encodeURIComponent(args.sessionId)}/permissions/${encodeURIComponent(args.permissionId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response: args.decision !== "deny",
          remember: args.decision === "accept-always",
        }),
      },
    );
  }

  private onOpencodeEvent(rt: ProjectRuntime, ev: OpencodeEvent): void {
    const props = ev.properties ?? {};

    switch (ev.type) {
      case "message.updated": {
        // Shape: { info: Message }, Message has id, sessionID, role.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info = (props as any).info;
        if (!info?.id || !info?.role) return;
        rt.messageRoles.set(info.id, info.role);
        if (info.role !== "assistant") return;
        const ctx = rt.threadsBySession.get(info.sessionID);
        if (!ctx) return;
        if (ctx.assistantMessageId !== info.id) {
          // A new assistant turn — reset accumulators.
          ctx.assistantMessageId = info.id;
          ctx.parts = new Map();
        }
        return;
      }
      case "message.part.updated": {
        // Shape: { part: Part } where Part has sessionID, messageID, type, text.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const part = (props as any).part;
        if (!part?.sessionID || !part?.messageID) return;
        const ctx = rt.threadsBySession.get(part.sessionID);
        if (!ctx?.stream) return;
        // Skip anything on a user message (our own echo) or a different turn.
        const role = rt.messageRoles.get(part.messageID);
        if (role === "user") return;
        if (ctx.assistantMessageId && ctx.assistantMessageId !== part.messageID) return;
        if (!ctx.assistantMessageId) ctx.assistantMessageId = part.messageID;

        const rendered = renderPart(part);
        if (rendered === null) return;
        ctx.parts.set(part.id, rendered);
        ctx.stream.replace([...ctx.parts.values()].filter(Boolean).join("\n\n"));
        return;
      }
      case "session.idle":
      case "session.completed": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessionId = (props as any).sessionID;
        if (!sessionId) return;
        const ctx = rt.threadsBySession.get(sessionId);
        if (!ctx) return;
        void ctx.stream?.finalize();
        if (ctx.backgroundUserId) {
          void this.notifyBackgroundCompletion(ctx);
        }
        return;
      }
      case "session.error": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = props as any;
        const sessionId = p.sessionID;
        if (!sessionId) return;
        const ctx = rt.threadsBySession.get(sessionId);
        const msg = p.error?.data?.message ?? p.error?.message ?? "Session errored.";
        void ctx?.stream?.finalize(`\n\n:warning: ${msg}`);
        return;
      }
      case "permission.updated":
      case "permission.asked": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = props as any;
        const sessionId = p.sessionID ?? p.sessionId;
        if (!sessionId) return;
        const ctx = rt.threadsBySession.get(sessionId);
        if (!ctx) return;
        const permissionId: string = p.permissionID ?? p.id ?? "";
        if (!permissionId || rt.permissionToSession.has(permissionId)) return;
        rt.permissionToSession.set(permissionId, sessionId);
        const title = p.title ?? p.tool ?? "Tool permission requested";
        const detail = p.description ?? formatPermissionDetail(p);
        void this.web.chat.postMessage({
          channel: ctx.channelId,
          thread_ts: ctx.threadTs,
          text: `Permission requested: ${title}`,
          blocks: permissionPromptBlocks({ sessionId, permissionId, title, detail }),
        });
        if (ctx.backgroundUserId) {
          void this.notifyBackgroundNeedsInput(ctx, title);
        }
        return;
      }
      default:
        log.debug("opencode event", ev.type);
    }
  }
}

function renderPart(part: {
  type: string;
  text?: string;
  tool?: string;
  state?: { status?: string; input?: unknown };
}): string | null {
  switch (part.type) {
    case "text":
      return part.text ?? "";
    case "reasoning":
      // Hide reasoning by default — it's usually noisy. Flip this to show it.
      return null;
    case "tool": {
      const status = part.state?.status ?? "";
      const name = part.tool ?? "tool";
      if (status === "completed" || status === "error") return null;
      return `:gear: \`${name}\`${status ? ` _${status}_` : ""}`;
    }
    case "step-start":
    case "step-finish":
    case "snapshot":
    case "patch":
      return null;
    default:
      return null;
  }
}

function formatPermissionDetail(props: Record<string, unknown>): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = props as any;
  if (p.command) return `$ ${p.command}`;
  if (p.args) return JSON.stringify(p.args, null, 2);
  return undefined;
}

/**
 * Call a nested SDK method like client.session.create(body) without binding
 * us to a specific SDK version's exported surface. Returns undefined if the
 * path doesn't exist (caller falls back to raw HTTP). Preserves `this` so
 * class methods that read `this._client` keep working.
 */
async function callOptional<T = unknown>(
  client: unknown,
  path: string[],
  args: unknown[],
): Promise<T | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parent: any = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any = client;
  for (const key of path) {
    if (target == null) return undefined;
    parent = target;
    target = target[key];
  }
  if (typeof target !== "function") return undefined;
  return (await target.apply(parent, args)) as T;
}
