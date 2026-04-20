const prefix = (tag: string, color: string) =>
  `\x1b[${color}m[${tag}]\x1b[0m`;

export const log = {
  info: (...args: unknown[]) => console.log(prefix("slackaki", "36"), ...args),
  warn: (...args: unknown[]) => console.warn(prefix("warn", "33"), ...args),
  error: (...args: unknown[]) => console.error(prefix("error", "31"), ...args),
  debug: (...args: unknown[]) => {
    if (process.env.SLACKAKI_DEBUG) {
      console.log(prefix("debug", "90"), ...args);
    }
  },
};
