#!/usr/bin/env node
import("../dist/cli.js").catch((err) => {
  console.error("Failed to start slackaki:", err);
  process.exit(1);
});
