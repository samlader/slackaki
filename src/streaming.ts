import type { WebClient } from "@slack/web-api";
import { log } from "./log.js";
import { mdToMrkdwn } from "./mrkdwn.js";

// Slack's chat.update is tier 3 (~50/min). To stay safe while streaming we
// throttle edits per-message to roughly one per second, and coalesce the latest
// text so we never queue stale content.
const MIN_EDIT_INTERVAL_MS = 900;
const MAX_BLOCK_CHARS = 2800; // stay under Slack's 3000-char section limit
const MAX_MESSAGE_CHARS = 38_000; // stay under Slack's 40k ceiling

export class StreamingMessage {
  private text = "";
  private pending = false;
  private lastEditAt = 0;
  private timer?: NodeJS.Timeout;
  private finished = false;

  constructor(
    private web: WebClient,
    private channel: string,
    private ts: string,
  ) {}

  append(chunk: string): void {
    if (this.finished) return;
    this.text += chunk;
    this.scheduleFlush();
  }

  replace(text: string): void {
    if (this.finished) return;
    this.text = text;
    this.scheduleFlush();
  }

  async finalize(trailer?: string): Promise<void> {
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (trailer) this.text += trailer;
    await this.flushNow();
  }

  private scheduleFlush(): void {
    if (this.pending) return;
    const elapsed = Date.now() - this.lastEditAt;
    const wait = Math.max(0, MIN_EDIT_INTERVAL_MS - elapsed);
    this.pending = true;
    this.timer = setTimeout(() => {
      this.pending = false;
      this.flushNow().catch((err) => log.error("flush failed", err));
    }, wait);
  }

  private async flushNow(): Promise<void> {
    const rendered = this.text ? mdToMrkdwn(this.text) : "_(thinking…)_";
    const truncated =
      rendered.length > MAX_MESSAGE_CHARS
        ? rendered.slice(0, MAX_MESSAGE_CHARS) + "\n\n_(output truncated — see thread for full log)_"
        : rendered;
    try {
      await this.web.chat.update({
        channel: this.channel,
        ts: this.ts,
        text: truncated.slice(0, 300),
        blocks: toBlocks(truncated),
      });
      this.lastEditAt = Date.now();
    } catch (err) {
      log.warn("chat.update failed", err);
    }
  }
}

function toBlocks(text: string) {
  const blocks = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX_BLOCK_CHARS);
    remaining = remaining.slice(chunk.length);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: chunk },
    });
  }
  return blocks;
}
