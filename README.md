![Maestro Samurai Banner](assets/maestro-samurai-banner.png)

# Maestro

**Orchestrate multiple AI coding assistants in parallel**

Maestro is a desktop app for developers who build software with AI coding assistants such as Claude Code. Instead of juggling a pile of terminal windows, you run up to 12 AI sessions side by side in one place, each working in its own isolated copy of your code (a git worktree), so they never trip over each other. Every session shows at a glance whether it is working, finished, or waiting for you, and an "eagle view" shows every terminal across all your projects at once, with the ability to zoom in, pin, or park any of them. Around the terminals, Maestro gives you the rest of the job in the same window: a visual git graph, your GitHub issues and pull requests, a map of which issues block which, a PR monitoring tower, a searchable History of past conversations with short AI summaries so you can resume any of them, notes and a "Second Brain" of saved reports, and cleanup tools for old branches and worktrees. For longer jobs, its Samurai supervisor can run agents unattended, hand work over to a fresh agent when one runs out of context, pause when your usage allowance runs low, and alert you only when something needs a human. The point of all this is to **help developers manage cognitive load when developing with an AI-driven development lifecycle (AI-DLC)**: when several agents work for you at once, Maestro keeps track of who is doing what, surfaces only what needs your attention, and lets you pick up any thread without having to hold it all in your head.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Troubleshooting](#troubleshooting)

---

## Getting Started

### On Windows: download the installer (easiest)

1. Go to the [Releases page](https://github.com/nachogl1/maestro/releases) and download the newest `.msi` file.
2. Double-click it and follow the steps. Then open **Maestro** from your Start menu.
3. Later updates arrive inside the app: open **Settings**, then **Updates**.

You still need Git and an AI assistant such as Claude Code installed (see Step 2, items 3 and 5).

### On macOS: download the app (easiest)

1. Go to the [Releases page](https://github.com/nachogl1/maestro/releases) and download the newest `_universal.dmg` file. It works on both Apple Silicon (M1 and newer) and Intel Macs, running macOS 10.15 or later.
2. Double-click the `.dmg`, then drag **Maestro** into the **Applications** folder.
3. **First launch only:** Maestro is not registered with Apple (that costs a yearly fee), so macOS blocks it the first time with a message such as *"Maestro cannot be opened"* or *"Maestro is damaged"*. The app is fine. To let it through, open the Terminal app and run:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Maestro.app
   ```
   Or try to open Maestro once, then go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.
4. Open **Maestro** from Applications or Launchpad. Later updates arrive inside the app: open **Settings**, then **Updates**. You won't need step 3 again.

You still need Git and an AI assistant such as Claude Code installed (see Step 2, items 3 and 5).

### On Linux (or if you prefer to build it yourself)

There is no ready-made installer for Linux yet, so you build Maestro on your own computer once. It sounds harder than it is: you install a few free tools, copy and paste a handful of commands, and wait.

### Step 1: Get the code

Pick **one** of these:

- **Download a ZIP (easiest):** at the top of this GitHub page, click the green **Code** button, then **Download ZIP**. Unzip it somewhere easy to find, such as your Documents folder.
- **Clone with Git:** if you already have Git, open a terminal and run `git clone https://github.com/nachogl1/maestro.git`.

Either way, you end up with a folder called `maestro` (or `maestro-main` if you used the ZIP).

### Step 2: Install the free tools Maestro needs

You only do this once. Install each one with its normal installer and accept the default options.

1. **Node.js** (version 20 or newer): download the "LTS" version from [nodejs.org](https://nodejs.org/).
2. **Rust** (version 1.89 or newer): follow the instructions at [rustup.rs](https://rustup.rs/). On Linux, use rustup rather than your system's package manager, which often ships an older version.
3. **Git**: download it from [git-scm.com](https://git-scm.com/downloads). Maestro uses Git to give each AI session its own copy of your code.
4. **Your computer's build tools:**
   - **Windows:** install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and tick **"Desktop development with C++"** during setup.
   - **macOS:** open the Terminal app and run `xcode-select --install`.
   - **Linux (Ubuntu / Debian):** run these commands in a terminal:
     ```bash
     sudo apt-get update
     sudo apt-get install -y build-essential pkg-config libssl-dev \
       libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
       libfontconfig1-dev patchelf
     ```
   - **Linux (Fedora):** run `sudo dnf install gcc-c++ pkg-config openssl-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel`.
   - **Linux (Arch):** run `sudo pacman -S base-devel pkgconf openssl webkit2gtk-4.1 libappindicator-gtk3 librsvg`.
   - **Windows only:** Maestro also needs WebView2, which is already on Windows 10 (21H2 or later) and Windows 11. On older versions, [download it here](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
5. **An AI assistant (recommended):** after Node.js is installed, open a terminal and run `npm install -g @anthropic-ai/claude-code` to get Claude Code.

After installing everything, **restart your computer** (or at least close and reopen your terminal) so it can find the new tools.

### Step 3: Open a terminal inside the Maestro folder

A terminal is a window where you type commands.

- **Windows:** open the `maestro` folder in File Explorer, click the address bar, type `powershell`, and press Enter.
- **macOS:** open the Terminal app, type `cd ` (with a space), drag the `maestro` folder into the window, and press Enter.
- **Linux:** right-click inside the `maestro` folder and choose **Open in Terminal**.

### Step 4: Build Maestro

Copy and paste these three commands, one at a time, pressing Enter after each and waiting for it to finish. The first build can take 10 to 20 minutes, and lots of text scrolling past is normal.

```bash
npm install
cargo build --release -p maestro-mcp-server
npm run tauri build
```

### Step 5: Install and open it

When the last command finishes, your installer is waiting in the folder `target/release/bundle/` inside the Maestro folder:

- **Windows:** open the `nsis` folder and double-click the `...-setup.exe` file (or use the `.msi` file in the `msi` folder).
- **macOS:** open the `dmg` folder and double-click the `.dmg` file, then drag Maestro into Applications.
- **Linux:** use the `.deb`, `.rpm`, or `.AppImage` file that matches your system.

Install it like any other app, then open **Maestro** from your Start menu, Applications folder, or app launcher.

### Step 6: Start using it

1. Choose a project folder (ideally one that already uses Git).
2. Open one or more terminals, pick Claude Code (or another assistant) for each, and give each a task.
3. Watch the coloured dots on each terminal: they tell you which sessions are working and which are waiting for you.

To update Maestro later, download the code again (or run `git pull` in the folder) and repeat Steps 4 and 5.

---

## Troubleshooting

### Claude Command Not Found

The Claude CLI must be installed globally and in your PATH:
```bash
npm install -g @anthropic-ai/claude-code
which claude  # Should show the path
```

### Worktree Issues

If worktrees get into a bad state:
```bash
# List all worktrees
git worktree list

# Remove a specific worktree
git worktree remove /path/to/worktree --force

# Prune stale worktree entries
git worktree prune
```

### Build Issues

If you encounter build issues:
```bash
# Clear the Rust build cache
rm -rf target

# Clear node modules and reinstall
rm -rf node_modules
npm install

# Rebuild MCP server first, then Tauri app
cargo build --release -p maestro-mcp-server
npm run tauri build
```
