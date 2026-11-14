---
layout: default
title: Troubleshooting
nav_order: 4
---

# Troubleshooting
{: .no_toc }

Common problems and how to fix them. If yours is not here, open an issue on
[GitHub](https://github.com/nachogl1/maestro/issues).
{: .fs-5 .fw-300 }

1. TOC
{:toc}

---

## Installing and opening

### macOS says "Maestro is damaged" or "cannot be opened"

Maestro is not registered with Apple, so macOS blocks its first launch. The app is fine. In the Terminal app, run:

```bash
xattr -dr com.apple.quarantine /Applications/Maestro.app
```

Or try to open Maestro once, then click **Open Anyway** in **System Settings → Privacy & Security**. You only do
this once; updates installed from inside the app open normally.

### Windows says "Windows protected your PC"

The installer is not signed with a paid code-signing certificate. Click **More info**, then **Run anyway**.

### macOS asks for Full Disk Access

Projects in protected folders (Desktop, Documents, Downloads) need it. When Maestro shows **Full Disk Access
Required**, click **Open System Settings**, turn Maestro on under **Privacy & Security → Full Disk Access**, and
restart Maestro.

---

## Terminals

### "claude: command not found", or a Claude terminal ends at once

Maestro starts the `claude` command it finds on your computer's PATH (the list of folders searched for commands).

1. Install Claude Code if it is missing: `npm install -g @anthropic-ai/claude-code`.
2. Open a new terminal window outside Maestro and run `claude --version`. If that fails, add npm's global folder to
   your PATH: `%AppData%\npm` on Windows; on macOS and Linux, the folder `npm prefix -g` prints, followed by `/bin`.
3. Quit and reopen Maestro, so it picks up the new PATH.

A plain shell terminal works without Claude Code, which helps tell a Claude Code problem from a Maestro one.

### A terminal's status looks wrong

Maestro learns what each Claude terminal is doing from its own Claude Code hooks, which it writes into the
project's `.claude/settings.local.json` next to any hooks of yours. Without them it guesses from the terminal's
output.

- Check that the project folder is writable, so Maestro can write that file.
- Close the terminal and open a new one; the hooks are added when a session starts.

### A terminal is blank or draws badly

- Resize the window or the terminal, which makes it redraw.
- On Windows, make sure WebView2 is installed (see [Installation]({% link installation.md %})).
- On Linux, make sure `libwebkit2gtk-4.1` is installed.

---

## Git and GitHub

### Pull requests, issues or the issue map stay empty

These use the GitHub CLI. Install it from [cli.github.com](https://cli.github.com/), run `gh auth login`, and make
sure the project's `origin` remote is on GitHub.

### Worktrees are in a bad state

In the project folder:

```bash
git worktree list    # what git knows about
git worktree prune   # forget worktrees whose folder is gone
git worktree remove <path>   # remove one you no longer need
```

`git worktree remove` refuses a worktree with uncommitted changes; commit or copy that work first. Maestro keeps
the worktrees it creates in its data folder: `%AppData%\maestro\maestro\data\worktrees` on Windows,
`~/Library/Application Support/com.maestro.maestro/worktrees` on macOS and `~/.local/share/maestro/worktrees` on
Linux.

**"Branch is already checked out"** means another worktree, or the main folder, already has that branch. Use that
terminal, pick another branch, or remove the stale worktree.

---

## Updates

### The update check fails or finds nothing

Download the newest installer from the [latest release](https://github.com/nachogl1/maestro/releases/latest) and
install it over the old one; your settings stay. A Maestro you built yourself on Linux has no in-app updates.

---

## Building from source

If a build fails, start clean from the Maestro folder:

```bash
rm -rf target node_modules
npm install
cargo build --release -p maestro-mcp-server
npm run tauri build
```

Check the versions too: Node.js 20 or newer and Rust 1.89 or newer (`node --version`, `rustc --version`).
