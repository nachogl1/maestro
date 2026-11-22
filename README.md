![Maestro Samurai Banner](assets/maestro-samurai-banner.png)

# Maestro

> ⚠️ **Experimental software: use at your own risk.** Maestro is an experimental tool, provided "as is" with no warranty of any kind (see the [MIT licence](legal/LICENSE)). It runs AI coding agents that can change your files, run commands and edit your Claude Code settings. You are responsible for what they do: review their changes, keep backups, and watch your AI usage and costs. The authors accept no liability for any loss or damage from using it.

**Orchestrate multiple AI coding assistants in parallel**

Maestro is a desktop app for developers who build software with AI coding assistants such as Claude Code. Instead of juggling a pile of terminal windows, you run up to 12 AI sessions side by side in one place, each working in its own isolated copy of your code (a git worktree), so they never trip over each other. Every session shows at a glance whether it is working, finished, or waiting for you, and an "eagle view" shows every terminal across all your projects at once, with the ability to zoom in, pin, or park any of them. Around the terminals, Maestro gives you the rest of the job in the same window: a visual git graph, your GitHub issues and pull requests, a map of which issues block which, a PR monitoring tower, a searchable History of past conversations with short AI summaries so you can resume any of them, notes, and cleanup tools for old branches and worktrees. The point of all this is to **help developers manage cognitive load when developing with an AI-driven development lifecycle (AI-DLC)**: when several agents work for you at once, Maestro keeps track of who is doing what, surfaces only what needs your attention, and lets you pick up any thread without having to hold it all in your head.

## Credits

Maestro was created by **Jack** ([AngryAnt3201](https://github.com/AngryAnt3201)). The original project is
[its-maestro-baby/maestro](https://github.com/its-maestro-baby/maestro), and all credit for building Maestro goes to
Jack and that project's contributors. This version was adapted by **Ignacio "Nacho" Gonzalez**. Licensed under
[MIT](legal/LICENSE).

---

## Download and install

**[nachogl1.github.io/maestro](https://nachogl1.github.io/maestro/)** is Maestro's public page: what it does, screenshots,
and the download buttons.

- **Windows and macOS:** download the installer from the [latest release](https://github.com/nachogl1/maestro/releases/latest),
  then follow the [installation steps](https://nachogl1.github.io/maestro/installation.html).
- **Linux:** there is no installer; the [installation steps](https://nachogl1.github.io/maestro/installation.html#linux-build-it-yourself)
  explain how to build it yourself.
- **Something not working?** See [Troubleshooting](https://nachogl1.github.io/maestro/troubleshooting.html).

The site's source is in [`website/`](website/) and is published from `main`.
