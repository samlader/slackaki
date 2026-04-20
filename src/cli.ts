import { Command } from "commander";
import { loadConfig, configPath } from "./config.js";
import { runSetup } from "./setup.js";
import { startSlackBridge } from "./slack.js";
import { log } from "./log.js";

const program = new Command();

program
  .name("slackaki")
  .description("Iron Man's Jarvis for coding agents, inside Slack.")
  .version("0.1.0");

program
  .command("setup")
  .description("Interactive setup wizard")
  .action(async () => {
    await runSetup();
  });

program
  .command("run", { isDefault: true })
  .description("Start the Slackaki bridge")
  .action(async () => {
    let config = loadConfig();
    if (!config) {
      log.info("No config found — running setup first.");
      config = await runSetup();
    }
    if (config.projects.length === 0) {
      log.warn("No projects linked. Run `slackaki setup` to add one.");
      process.exit(1);
    }

    const shutdown = await startSlackBridge(config);
    const stop = async (signal: string) => {
      log.info(`\nReceived ${signal}, shutting down…`);
      try {
        await shutdown();
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGINT", () => void stop("SIGINT"));
    process.on("SIGTERM", () => void stop("SIGTERM"));
  });

program
  .command("config")
  .description("Print the path to the config file")
  .action(() => {
    console.log(configPath());
  });

program.parseAsync(process.argv).catch((err) => {
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
