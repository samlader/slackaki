import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface State {
  // channelId → threadTs → opencode sessionId
  threads: Record<string, Record<string, string>>;
}

const STATE_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "slackaki",
);
const STATE_PATH = path.join(STATE_DIR, "state.json");

export class StateStore {
  private state: State = load();

  getSession(channelId: string, threadTs: string): string | undefined {
    return this.state.threads[channelId]?.[threadTs];
  }

  setSession(channelId: string, threadTs: string, sessionId: string): void {
    if (!this.state.threads[channelId]) this.state.threads[channelId] = {};
    this.state.threads[channelId][threadTs] = sessionId;
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const tmp = STATE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_PATH);
  }
}

function load(): State {
  if (!fs.existsSync(STATE_PATH)) return { threads: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as State;
    return { threads: parsed.threads ?? {} };
  } catch {
    return { threads: {} };
  }
}
