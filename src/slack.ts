import Bolt from "@slack/bolt";
import { Config, findProjectByChannel } from "./config.js";
import { SessionManager } from "./session.js";
import {
  ACTION_PERMISSION_ACCEPT,
  ACTION_PERMISSION_ACCEPT_ALWAYS,
  ACTION_PERMISSION_DENY,
} from "./blocks.js";
import { ScheduleStore } from "./schedules.js";
import { Scheduler, naturalLanguageToCron } from "./scheduler.js";
import { log } from "./log.js";

const { App } = Bolt;

export async function startSlackBridge(config: Config): Promise<() => Promise<void>> {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  const sessions = new SessionManager(app.client, config.projects);
  const schedules = new ScheduleStore();
  const scheduler = new Scheduler(schedules, async (job) => {
    const mapping = sessions.projectForChannel(job.channelId);
    if (!mapping) {
      log.warn(`schedule ${job.id} fires for unmapped channel ${job.channelId}`);
      return;
    }
    await sessions.fireScheduled(mapping, job.prompt, job.createdByUserId, job.naturalLanguage);
  });
  const selfAuth = await app.client.auth.test();
  const botUserId = selfAuth.user_id;
  const mentionRegex = botUserId ? new RegExp(`<@${botUserId}>`) : null;

  app.message(async ({ message }) => {
    if (message.subtype && message.subtype !== "file_share") return;
    if (!("user" in message) || !message.user) return;
    if (!("text" in message) || !message.text) return;
    if (!message.channel) return;

    const mapping = sessions.projectForChannel(message.channel);
    if (!mapping) return;
    if (botUserId && message.user === botUserId) return;

    const threadTs = "thread_ts" in message ? message.thread_ts : undefined;
    // Top-level messages require an @mention. Thread replies always get a response.
    if (!threadTs && mentionRegex && !mentionRegex.test(message.text)) return;

    const cleaned = mentionRegex ? message.text.replace(mentionRegex, "").trim() : message.text;
    if (!cleaned) return;

    await sessions.handleUserMessage({
      mapping,
      channelId: message.channel,
      messageTs: message.ts,
      threadTs,
      text: cleaned,
      userId: message.user,
    });
  });

  app.command("/session", async ({ command, ack, respond }) => {
    await ack();
    const mapping = findProjectByChannel(config, command.channel_id);
    if (!mapping) {
      await respond({
        response_type: "ephemeral",
        text: "This channel isn't linked to a Slackaki project. Run `slackaki setup` to add one.",
      });
      return;
    }
    if (!command.text?.trim()) {
      await respond({ response_type: "ephemeral", text: "Usage: `/session <prompt>`" });
      return;
    }
    const posted = await app.client.chat.postMessage({
      channel: command.channel_id,
      text: command.text,
      username: command.user_name,
    });
    if (!posted.ts) return;
    await sessions.handleUserMessage({
      mapping,
      channelId: command.channel_id,
      messageTs: posted.ts,
      text: command.text,
      userId: command.user_id,
    });
  });

  app.command("/background", async ({ command, ack, respond }) => {
    await ack();
    const mapping = findProjectByChannel(config, command.channel_id);
    if (!mapping) {
      await respond({
        response_type: "ephemeral",
        text: "This channel isn't linked to a Slackaki project.",
      });
      return;
    }
    const prompt = command.text?.trim();
    if (!prompt) {
      await respond({ response_type: "ephemeral", text: "Usage: `/background <prompt>`" });
      return;
    }
    const posted = await app.client.chat.postMessage({
      channel: command.channel_id,
      text: `:robot_face: *Background task from <@${command.user_id}>:*\n${prompt}`,
    });
    if (!posted.ts) return;
    await sessions.handleUserMessage({
      mapping,
      channelId: command.channel_id,
      messageTs: posted.ts,
      text: prompt,
      userId: command.user_id,
      background: true,
    });
    await respond({
      response_type: "ephemeral",
      text: ":white_check_mark: Running in the background — I'll DM you when it finishes or needs input.",
    });
  });

  app.command("/abort", async ({ command, ack, respond }) => {
    await ack();
    const threadTs = command.thread_ts || undefined;
    if (!threadTs) {
      await respond({
        response_type: "ephemeral",
        text: "Run `/abort` from within a session thread.",
      });
      return;
    }
    const ok = await sessions.abortActiveSession(command.channel_id, threadTs);
    await respond({
      response_type: "ephemeral",
      text: ok ? "Aborted." : "No active session in this thread.",
    });
  });

  app.command("/schedule", async ({ command, ack, respond }) => {
    await ack();
    const mapping = findProjectByChannel(config, command.channel_id);
    if (!mapping) {
      await respond({ response_type: "ephemeral", text: "This channel isn't linked to a Slackaki project." });
      return;
    }
    const raw = command.text?.trim() ?? "";
    const pipe = raw.indexOf("|");
    if (pipe < 0) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/schedule <when> | <prompt>` — e.g. `/schedule every weekday at 9am | review open PRs`",
      });
      return;
    }
    const when = raw.slice(0, pipe).trim();
    const prompt = raw.slice(pipe + 1).trim();
    if (!when || !prompt) {
      await respond({ response_type: "ephemeral", text: "Both a schedule and a prompt are required." });
      return;
    }
    await respond({ response_type: "ephemeral", text: `:thinking_face: Working out when \`${when}\` means…` });
    let cron: string | null;
    try {
      const server = await sessions.getServer(mapping);
      cron = await naturalLanguageToCron(server, when);
    } catch (err) {
      log.error("schedule parse failed", err);
      await respond({ response_type: "ephemeral", text: `:warning: Failed to parse schedule: ${String(err)}` });
      return;
    }
    if (!cron) {
      await respond({
        response_type: "ephemeral",
        text: `:warning: Couldn't turn \`${when}\` into a cron expression. Try something simpler, or paste a 5-field cron directly.`,
      });
      return;
    }
    const entry = schedules.add({
      channelId: command.channel_id,
      createdByUserId: command.user_id,
      cron,
      naturalLanguage: when,
      prompt,
    });
    await respond({
      response_type: "in_channel",
      text: `:alarm_clock: Scheduled \`${cron}\` (from \`${when}\`) — id \`${entry.id}\`. Remove with \`/unschedule ${entry.id}\`.`,
    });
  });

  app.command("/schedules", async ({ command, ack, respond }) => {
    await ack();
    const list = schedules.list(command.channel_id);
    if (list.length === 0) {
      await respond({ response_type: "ephemeral", text: "No scheduled tasks in this channel." });
      return;
    }
    const lines = list.map((s) => {
      const last = s.lastFiredAt ? new Date(s.lastFiredAt).toLocaleString() : "never";
      return `• \`${s.id}\` · \`${s.cron}\` (${s.naturalLanguage}) — last fired: ${last}\n    ↳ ${s.prompt}`;
    });
    await respond({ response_type: "ephemeral", text: lines.join("\n") });
  });

  app.command("/unschedule", async ({ command, ack, respond }) => {
    await ack();
    const id = command.text?.trim();
    if (!id) {
      await respond({ response_type: "ephemeral", text: "Usage: `/unschedule <id>` — find ids via `/schedules`." });
      return;
    }
    const removed = schedules.remove(id);
    await respond({
      response_type: "ephemeral",
      text: removed ? `Removed schedule \`${id}\`.` : `No schedule with id \`${id}\`.`,
    });
  });

  app.command("/add-project", async ({ ack, respond }) => {
    await ack();
    await respond({
      response_type: "ephemeral",
      text: "Run `slackaki setup` in the terminal to add a project — it needs filesystem access.",
    });
  });

  const permissionHandler = (decision: "accept" | "accept-always" | "deny") =>
    async ({
      ack,
      body,
      action,
    }: Bolt.SlackActionMiddlewareArgs<Bolt.BlockButtonAction>) => {
      await ack();
      const raw = "value" in action ? action.value : undefined;
      if (!raw) return;
      let parsed: { sessionId: string; permissionId: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const channel = body.channel?.id;
      const messageTs = body.message?.ts;
      if (!channel || !messageTs) return;
      await sessions.respondToPermission({
        sessionId: parsed.sessionId,
        permissionId: parsed.permissionId,
        decision,
        userId: body.user.id,
        channel,
        messageTs,
      });
    };

  app.action(ACTION_PERMISSION_ACCEPT, permissionHandler("accept"));
  app.action(ACTION_PERMISSION_ACCEPT_ALWAYS, permissionHandler("accept-always"));
  app.action(ACTION_PERMISSION_DENY, permissionHandler("deny"));

  // Placeholders for commands that aren't wired end-to-end yet.
  const stubs = [
    "/resume",
    "/fork",
    "/queue",
    "/clear-queue",
    "/undo",
    "/redo",
    "/model",
    "/agent",
    "/share",
    "/new-worktree",
    "/merge-worktree",
    "/create-new-project",
    "/screenshare",
    "/screenshare-stop",
    "/upgrade-and-restart",
  ];
  for (const name of stubs) {
    app.command(name, async ({ ack, respond }) => {
      await ack();
      await respond({
        response_type: "ephemeral",
        text: `\`${name}\` isn't implemented in this build yet.`,
      });
    });
  }

  await app.start();
  scheduler.start();
  log.info("Slackaki is online. Post a message in a linked channel to start a session.");

  return async () => {
    scheduler.stop();
    await app.stop();
    await sessions.shutdown();
  };
}
