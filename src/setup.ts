import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import { WebClient } from "@slack/web-api";
import {
  Config,
  configPath,
  loadConfig,
  saveConfig,
  upsertProject,
} from "./config.js";
import { log } from "./log.js";

const MANIFEST_URL = "https://github.com/samlader/slackaki/blob/main/manifest.json";

export async function runSetup(): Promise<Config> {
  log.info("Welcome to Slackaki setup.");

  const existing = loadConfig();
  if (existing) {
    const { reuse } = await prompts({
      type: "confirm",
      name: "reuse",
      message: `Found existing config at ${configPath()}. Add another project to it?`,
      initial: true,
    });
    if (reuse) return addProjectFlow(existing);
  }

  log.info(`\n1. Go to https://api.slack.com/apps and click "Create New App" → "From a manifest".`);
  log.info(`   Paste the manifest from: ${MANIFEST_URL}`);
  log.info(`2. Under "Basic Information → App-Level Tokens", generate a token with connections:write.`);
  log.info(`3. Install the app to your workspace and copy the Bot User OAuth Token.\n`);

  const tokens = await prompts([
    {
      type: "password",
      name: "botToken",
      message: "Bot User OAuth Token (xoxb-...)",
      validate: (v: string) => v.startsWith("xoxb-") || "Must start with xoxb-",
    },
    {
      type: "password",
      name: "appToken",
      message: "App-Level Token (xapp-...)",
      validate: (v: string) => v.startsWith("xapp-") || "Must start with xapp-",
    },
  ]);

  if (!tokens.botToken || !tokens.appToken) throw new Error("Setup cancelled.");

  const web = new WebClient(tokens.botToken);
  try {
    const auth = await web.auth.test();
    log.info(`Connected as ${auth.user} in workspace ${auth.team}.`);
  } catch (err) {
    throw new Error(`Slack auth test failed: ${String(err)}`);
  }

  const { wantGemini } = await prompts({
    type: "confirm",
    name: "wantGemini",
    message: "Enable voice-message transcription via Gemini?",
    initial: false,
  });

  let gemini: Config["gemini"];
  if (wantGemini) {
    const { apiKey } = await prompts({
      type: "password",
      name: "apiKey",
      message: "Gemini API key",
    });
    if (apiKey) gemini = { apiKey };
  }

  let config: Config = {
    slack: { botToken: tokens.botToken, appToken: tokens.appToken },
    gemini,
    projects: [],
  };

  config = await addProjectFlow(config, web);

  saveConfig(config);
  log.info(`\nSaved config to ${configPath()}.`);
  log.info(`Run "slackaki run" (or just "slackaki") to start the bridge.`);
  return config;
}

export async function addProjectFlow(
  config: Config,
  web?: WebClient,
): Promise<Config> {
  const client = web ?? new WebClient(config.slack.botToken);

  const { projectDir } = await prompts({
    type: "text",
    name: "projectDir",
    message: "Project directory",
    initial: process.cwd(),
    validate: (v: string) => {
      const resolved = path.resolve(v);
      return fs.existsSync(resolved) || "Directory does not exist";
    },
  });
  if (!projectDir) return config;

  const channels = await listJoinableChannels(client);
  if (channels.length === 0) {
    log.warn("No channels visible. Invite the Slackaki bot to a channel first, then re-run setup.");
    return config;
  }

  const { channel } = await prompts({
    type: "autocomplete",
    name: "channel",
    message: "Which Slack channel should map to this project?",
    choices: channels.map((c) => ({ title: `#${c.name}`, value: c })),
  });
  if (!channel) return config;

  try {
    await client.conversations.join({ channel: channel.id });
  } catch {
    // Already in, or private — ignore.
  }

  return upsertProject(config, {
    channelId: channel.id,
    channelName: channel.name,
    projectDir: path.resolve(projectDir),
  });
}

async function listJoinableChannels(
  web: WebClient,
): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  let cursor: string | undefined;
  do {
    const res = await web.conversations.list({
      exclude_archived: true,
      limit: 200,
      types: "public_channel,private_channel",
      cursor,
    });
    for (const c of res.channels ?? []) {
      if (c.id && c.name) out.push({ id: c.id, name: c.name });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}
