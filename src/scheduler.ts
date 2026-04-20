import { ScheduleStore, Schedule } from "./schedules.js";
import { parseCron, cronMatches, isValidCron } from "./cron.js";
import { OpencodeServer } from "./opencode.js";
import { log } from "./log.js";

const TICK_INTERVAL_MS = 30_000;

const CRON_SYSTEM_PROMPT = `You convert natural-language schedule descriptions into standard 5-field cron expressions.

Rules:
- Output ONLY the cron expression, with nothing before or after it — no commentary, no code fence, no explanation.
- Use the 5-field form: minute hour day-of-month month day-of-week (Sunday=0).
- Assume the user's local timezone.
- If the input already looks like a valid 5-field cron expression, output it unchanged.

Examples:
- "every weekday at 9am" → 0 9 * * 1-5
- "daily at midnight" → 0 0 * * *
- "every 15 minutes" → */15 * * * *
- "first of the month at noon" → 0 12 1 * *
- "0 9 * * *" → 0 9 * * *`;

export class Scheduler {
  private timer?: NodeJS.Timeout;

  constructor(
    private store: ScheduleStore,
    private fire: (schedule: Schedule) => Promise<void>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((err) => log.error("scheduler tick failed", err)), TICK_INTERVAL_MS);
    this.timer.unref();
    log.info(`Scheduler started (${this.store.all().length} job${this.store.all().length === 1 ? "" : "s"}).`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const minuteKey = Math.floor(now.getTime() / 60_000);
    for (const job of this.store.all()) {
      const parsed = parseCron(job.cron);
      if (!parsed) continue;
      if (!cronMatches(parsed, now)) continue;
      if (job.lastFiredAt && Math.floor(job.lastFiredAt / 60_000) === minuteKey) continue;
      try {
        await this.fire(job);
        this.store.markFired(job.id, now.getTime());
      } catch (err) {
        log.error(`scheduled job ${job.id} failed`, err);
      }
    }
  }
}

/**
 * Ask OpenCode to convert natural-language schedule text into a cron
 * expression. Uses a throwaway session so there's no UI fallout in the user's
 * channel.
 */
export async function naturalLanguageToCron(
  server: OpencodeServer,
  input: string,
): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isValidCron(trimmed)) return trimmed;

  const client = server.client();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyClient = client as any;
  const created = await anyClient.session.create({ body: { title: "schedule-parse" } });
  const sessionId = created?.data?.id;
  if (!sessionId) return null;

  try {
    const result = await anyClient.session.prompt({
      path: { id: sessionId },
      body: {
        system: CRON_SYSTEM_PROMPT,
        tools: {},
        parts: [{ type: "text", text: trimmed }],
      },
    });
    const parts: Array<{ type: string; text?: string }> = result?.data?.parts ?? [];
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    return extractCron(text);
  } finally {
    try {
      await anyClient.session.delete({ path: { id: sessionId } });
    } catch {
      // best effort
    }
  }
}

function extractCron(text: string): string | null {
  // The model should return just the cron expression, but we tolerate a
  // little noise (code fences, stray punctuation).
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^`+|`+$/g, "").trim();
    if (!line) continue;
    if (isValidCron(line)) return line;
  }
  return null;
}
