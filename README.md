# Slackaki

Slackaki is a Slack app that lets you control [OpenCode](https://opencode.ai) coding sessions from Slack.

Send a message in a Slack channel to spawn an agent to run & edit code on your machine or server.

Inspired by [Kimaki](https://github.com/remorses/kimaki) for Discord.

## Quick start

```
npx -y github:samlader/slackaki
```

Or from source:

```
npm install
npm run build
node bin/slackaki.js setup   # setup wizard
node bin/slackaki.js         # start the bridge
```

The CLI walks you athrough installing the Slack app, pasting tokens, and linking your first channel to a project directory.

## Requirements

- Node.js 20+
- [OpenCode](https://opencode.ai) installed on your PATH (`opencode serve` must work)
- A Slack workspace you can add an app to

## Status

This is an MVP. Working in this build:

- Socket Mode connection to Slack
- Channel → project mapping via the setup wizard
- Messages in a linked channel open a thread and start an OpenCode session
- Streaming assistant replies (rate-limited Slack edits)
- Tool-permission approvals via Block Kit buttons
- `/session`, `/abort` slash commands

Stubbed / not yet wired: `/resume`, `/fork`, `/undo`, `/redo`, `/model`, `/agent`, `/share`, `/queue`, voice transcription, screenshare, worktree commands.

## Contributions

Contributions and bug reports are welcome! Feel free to open issues, submit pull requests or contact me if you need any support.

## License

This project is licensed under the [MIT License](LICENSE).
