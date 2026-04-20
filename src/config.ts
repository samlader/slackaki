import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ProjectMapping {
  channelId: string;
  channelName: string;
  projectDir: string;
  defaultModel?: string;
  defaultAgent?: string;
}

export interface Config {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret?: string;
  };
  gemini?: {
    apiKey: string;
  };
  projects: ProjectMapping[];
}

const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "slackaki",
);
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function configPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): Config | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch (err) {
    throw new Error(`Corrupt config at ${CONFIG_PATH}: ${String(err)}`);
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function findProjectByChannel(
  config: Config,
  channelId: string,
): ProjectMapping | undefined {
  return config.projects.find((p) => p.channelId === channelId);
}

export function upsertProject(config: Config, project: ProjectMapping): Config {
  const idx = config.projects.findIndex((p) => p.channelId === project.channelId);
  const next = [...config.projects];
  if (idx >= 0) next[idx] = project;
  else next.push(project);
  return { ...config, projects: next };
}
