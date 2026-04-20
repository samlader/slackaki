import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface Schedule {
  id: string;
  channelId: string;
  createdByUserId: string;
  cron: string;
  naturalLanguage: string;
  prompt: string;
  createdAt: number;
  lastFiredAt?: number;
}

interface Store {
  schedules: Schedule[];
}

const DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "slackaki",
);
const PATH = path.join(DIR, "schedules.json");

export class ScheduleStore {
  private store: Store = load();

  list(channelId?: string): Schedule[] {
    return channelId
      ? this.store.schedules.filter((s) => s.channelId === channelId)
      : this.store.schedules.slice();
  }

  all(): Schedule[] {
    return this.store.schedules.slice();
  }

  add(input: Omit<Schedule, "id" | "createdAt">): Schedule {
    const entry: Schedule = {
      ...input,
      id: crypto.randomBytes(3).toString("hex"),
      createdAt: Date.now(),
    };
    this.store.schedules.push(entry);
    this.persist();
    return entry;
  }

  remove(id: string): boolean {
    const before = this.store.schedules.length;
    this.store.schedules = this.store.schedules.filter((s) => s.id !== id);
    if (this.store.schedules.length === before) return false;
    this.persist();
    return true;
  }

  markFired(id: string, at: number): void {
    const job = this.store.schedules.find((s) => s.id === id);
    if (!job) return;
    job.lastFiredAt = at;
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const tmp = PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, PATH);
  }
}

function load(): Store {
  if (!fs.existsSync(PATH)) return { schedules: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(PATH, "utf8")) as Store;
    return { schedules: parsed.schedules ?? [] };
  } catch {
    return { schedules: [] };
  }
}
