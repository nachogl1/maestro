![Maestro Samurai Banner](assets/maestro-samurai-banner.png)

# Maestro

**Orchestrate multiple AI coding assistants in parallel**

Maestro is a desktop app for developers who build software with AI coding assistants such as Claude Code. Instead of juggling a pile of terminal windows, you run up to 12 AI sessions side by side in one place, each working in its own isolated copy of your code (a git worktree), so they never trip over each other. Every session shows at a glance whether it is working, finished, or waiting for you, and an "eagle view" shows every terminal across all your projects at once, with the ability to zoom in, pin, or park any of them. Around the terminals, Maestro gives you the rest of the job in the same window: a visual git graph, your GitHub issues and pull requests, a map of which issues block which, a PR monitoring tower, a searchable History of past conversations with short AI summaries so you can resume any of them, notes and a "Second Brain" of saved reports, and cleanup tools for old branches and worktrees. For longer jobs, its Samurai supervisor can run agents unattended, hand work over to a fresh agent when one runs out of context, pause when your usage allowance runs low, and alert you only when something needs a human. The point of all this is to **help developers manage cognitive load when developing with an AI-driven development lifecycle (AI-DLC)**: when several agents work for you at once, Maestro keeps track of who is doing what, surfaces only what needs your attention, and lets you pick up any thread without having to hold it all in your head.

![Claude Maestro Platform](assets/platform_screenshot.png)

A cross-platform desktop application that lets you run 1-12 Claude Code (or other AI CLI) sessions simultaneously, each in its own isolated git worktree.

![macOS](https://img.shields.io/badge/macOS-13%2B-blue)
![Windows](https://img.shields.io/badge/Windows-10%2B-blue)
![Linux](https://img.shields.io/badge/Linux-supported-blue)
![Rust](https://img.shields.io/badge/Rust-1.78%2B-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
[![X (Twitter)](https://img.shields.io/badge/X-@maestro5240871-000000?style=flat&logo=x&logoColor=white)](https://x.com/maestro5240871)
[![Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2?style=flat&logo=discord&logoColor=white)](https://discord.gg/3tQyFUYPVP)

[![Docs](https://img.shields.io/badge/docs-website-blue)](https://its-maestro-baby.github.io/maestro/)
[![CI](https://github.com/nachogl1/maestro/actions/workflows/ci.yml/badge.svg)](https://github.com/nachogl1/maestro/actions/workflows/ci.yml)

**Star us on GitHub — your support motivates us a lot!**

---

## Table of Contents

- [Getting Started (No Technical Background Needed)](#getting-started-no-technical-background-needed)
- [Why Maestro?](#why-maestro)
- [Features](#features)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Getting Started (No Technical Background Needed)

There is no ready-made installer to download yet, so you build Maestro on your own computer once. It sounds harder than it is: you install a few free tools, copy and paste a handful of commands, and wait. The full technical details are in [Installation](#installation) below.

### Step 1: Get the code

Pick **one** of these:

- **Download a ZIP (easiest):** at the top of this GitHub page, click the green **Code** button, then **Download ZIP**. Unzip it somewhere easy to find, such as your Documents folder.
- **Clone with Git:** if you already have Git, open a terminal and run `git clone https://github.com/nachogl1/maestro.git`.

Either way, you end up with a folder called `maestro` (or `maestro-main` if you used the ZIP).

### Step 2: Install the free tools Maestro needs

You only do this once. Install each one with its normal installer and accept the default options.

1. **Node.js** (version 20 or newer): download the "LTS" version from [nodejs.org](https://nodejs.org/).
2. **Rust**: follow the instructions at [rustup.rs](https://rustup.rs/).
3. **Git**: download it from [git-scm.com](https://git-scm.com/downloads). Maestro uses Git to give each AI session its own copy of your code.
4. **Your computer's build tools:**
   - **Windows:** install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and tick **"Desktop development with C++"** during setup.
   - **macOS:** open the Terminal app and run `xcode-select --install`.
   - **Linux:** see the [Platform-Specific Prerequisites](#platform-specific-prerequisites) list below.
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

## Why Maestro?

**The Problem:** AI coding assistants work on one task at a time. While Claude works on Feature A, you wait. Then you start Feature B. Then you wait again. Context switching is expensive, and your development velocity is bottlenecked by serial execution.

**The Solution:** Run multiple AI sessions in parallel. Each session gets its own:
- Terminal instance with full shell environment
- Git worktree for complete code isolation
- Assigned branch for focused work
- Port allocation for web development

### Core Principles

| Principle | Description |
|-----------|-------------|
| **Parallel Development** | Launch 1-12 AI sessions simultaneously. Work on feature branches, bug fixes, and refactoring all at once. |
| **True Isolation** | Each session operates in its own git worktree. No merge conflicts, no stepping on each other's changes. |
| **AI-Native Workflow** | Built specifically for Claude Code, Gemini CLI, OpenAI Codex, and other AI coding assistants. |
| **Cross-Platform** | Runs on macOS, Windows, and Linux with native performance. |

---

## Features

### Multi-Terminal Session Grid
- Dynamic grid layout (1x1 to 2x3) that adapts to your session count
- Real-time status indicators: idle, working, waiting for input, done, error
- Per-session mode selection (Claude Code, Gemini CLI, OpenAI Codex, Plain Terminal)

### Git Worktree Isolation
- Automatic worktree creation at `~/.claude-maestro/worktrees/`
- Each session works on its own branch without conflicts
- Worktrees are pruned on session close
- Visual branch assignment in the sidebar
- "Worktree" badge in the terminal header when a session is running in a worktree

### MCP Server Integration
- Built-in MCP server for agent status reporting
- AI sessions report their state (idle, working, needs input, finished, error)
- Real-time status updates displayed in the session grid
- Uses the `maestro_status` tool for state communication

### Visual Git Graph
- GitKraken-style commit visualization
- Branch relationship view with colored rails
- Commit detail panel with diffs
- See which sessions are working on which branches

### Quick Actions
- Custom action buttons per session
- "Run App", "Commit & Push", and custom prompts
- Execute commands via AI assistant

### Appearance Settings
- Light and dark theme support
- Terminal font customization with support for:
  - System-installed fonts
  - Nerd Fonts (icons and glyphs)
  - Custom fonts
- Adjustable text size for terminal display

### Multi-AI Support
- **Claude Code** - Anthropic's Claude in the terminal
- **Gemini CLI** - Google's Gemini AI
- **OpenAI Codex** - OpenAI's coding assistant
- **Plain Terminal** - Standard shell without AI

### Plugin Marketplace
- Browse and install plugins from marketplace sources
- Plugin types: Skills, Commands, and MCP servers
- Per-session plugin configuration
- Automatic symlink management for commands and skills
- Extend Maestro's capabilities with community plugins

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Alt+1-4** | Toggle the left sidebar on the General / History / Infra / Settings tab |
| **Cmd+2-6** | Toggle the right-side Git / Memory / Processes / Notes / Standup panel |
| **Cmd+T** | New terminal (stays in zoom-in view; project picker in eagle view) |
| **Cmd+1** | Zoom the focused terminal (toggle) |
| **Alt+←** / **Alt+→** | Previous / next terminal tab while zoomed |
| **Cmd+Alt+←** / **Cmd+Alt+→** | Focus the previous / next terminal |
| **Cmd+G** | Toggle eagle view (all projects' terminals) |
| **Alt+P** | Park the focused terminal |
| **Ctrl+Tab** / **Ctrl+Shift+Tab** | Next / previous project (Ctrl on all platforms) |
| **Cmd+K** | Clear terminal scrollback |
| **Cmd+C** | Copy selection (SIGINT if no selection) |
| **Shift+Enter** | Newline without executing |
| **Cmd+Left** / **Cmd+Right** | Jump to line start / end (macOS only) |
| **Cmd+Backspace** | Delete to line start (macOS only) |

> **Note:** Cmd = Ctrl on Windows/Linux

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Claude Maestro (Tauri)                       │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Session 1   │  │  Session 2   │  │  Session 3   │   ...    │
│  │ Claude Code  │  │ Gemini CLI   │  │  Terminal    │          │
│  │ feature/auth │  │ fix/bug-123  │  │    main      │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                   │
│  ┌──────▼─────────────────▼─────────────────▼───────┐          │
│  │              ProcessManager (Rust)               │          │
│  │     ~/.claude-maestro/worktrees/{repo}/{branch}  │          │
│  └──────────────────────────────────────────────────┘          │
│                                                                 │
│  Frontend: React + TypeScript + Tailwind CSS                    │
│  Backend: Rust + Tauri                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ MCP Protocol (stdio)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    MCP Server (Rust)                            │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                     StatusManager                           ││
│  │  maestro_status tool - agents report their current state    ││
│  │  (idle, working, needs_input, finished, error)              ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology |
|-----------|------------|
| Desktop App | Tauri 2.0, Rust |
| Frontend | React, TypeScript, Tailwind CSS |
| Terminal Emulator | xterm.js |
| MCP Server | Rust |
| Git Operations | Native git CLI |

---

## Installation

### Requirements

- **Node.js** 20+ and npm
- **Rust** 1.78+ (for building from source) - install via [rustup](https://rustup.rs/), not system packages
- **Git** (for worktree operations)

#### Platform-Specific Prerequisites

**macOS** (13 Ventura or later):
```bash
# Install Xcode Command Line Tools
xcode-select --install
```

**Windows** (10 or later):
- Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **"Desktop development with C++"** workload
- Install [Rust](https://rustup.rs/)
- WebView2 Runtime is required (pre-installed on Windows 10 21H2+ and Windows 11; [download here](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) for older versions)

**Linux** (Ubuntu 24.04 LTS / Debian):
```bash
# Install Rust via rustup (Ubuntu 24.04's apt packages ship Rust 1.75, which is too old)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Install required system dependencies
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  libfontconfig1-dev patchelf
```

> **Note:** On Ubuntu 24.04, use `libayatana-appindicator3-dev` instead of `libappindicator3-dev` to avoid package conflicts.

**Linux** (Fedora):
```bash
sudo dnf install gcc-c++ pkg-config openssl-devel \
  webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel
```

**Linux** (Arch):
```bash
sudo pacman -S base-devel pkgconf openssl \
  webkit2gtk-4.1 libappindicator-gtk3 librsvg
```

### Build from Source

1. **Clone the repository:**
   ```bash
   git clone https://github.com/nachogl1/maestro.git
   cd maestro
   ```

2. **Install npm dependencies:**
   ```bash
   npm install
   ```

3. **Build the MCP server:**
   ```bash
   cargo build --release -p maestro-mcp-server
   ```
   This builds the Rust MCP server binary that Tauri bundles with the application.

4. **Run in development mode:**
   ```bash
   npm run tauri dev
   ```

5. **Build for production:**
   ```bash
   npm run tauri build
   ```
   The built application will be in `target/release/bundle/`.

### Optional: Install AI CLIs

```bash
# Claude Code (recommended)
npm install -g @anthropic-ai/claude-code

# Gemini CLI
npm install -g @google/gemini-cli

# OpenAI Codex
npm install -g @openai/codex
```

---

## Usage

### Quick Start

1. **Launch Claude Maestro**
2. **Select a project directory** (ideally a git repository)
3. **Configure sessions** in the sidebar:
   - Set the number of terminals (1-12)
   - Choose AI mode for each session
   - Assign branches to sessions
4. **Click "Launch"** to start all sessions
5. Each session opens in its own worktree with the AI ready to work

### Session Management

- **Add sessions:** Click the floating `+` button
- **Close sessions:** Click the `×` on the session header
- **Change mode:** Use the mode dropdown in the session header
- **Assign branch:** Select from the branch dropdown

### Git Worktree Isolation

When you assign a branch to a session:
1. Maestro creates a worktree at `~/.claude-maestro/worktrees/{repo-hash}/{branch}`
2. The session's terminal opens in that worktree
3. All file changes are isolated to that worktree
4. Worktrees are cleaned up when sessions close

### Quick Actions

Each session can have quick action buttons:
- **Run App** - Tells the AI to run the application
- **Commit & Push** - Tells the AI to commit and push changes
- **Custom** - Configure your own prompts

---

## Configuration

### MCP Configuration

Copy the example configuration and update paths:
```bash
cp .mcp.json.example .mcp.json
```

Edit `.mcp.json` to configure the MCP server for agent status reporting.

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
# Clear all Rust build caches
rm -rf src-tauri/target
rm -rf maestro-mcp-server/target

# Clear node modules and reinstall
rm -rf node_modules
npm install

# Rebuild MCP server first, then Tauri app
cargo build --release -p maestro-mcp-server
npm run tauri build
```

---

## Contributing

### Development Setup

1. Fork and clone the repository
2. Install npm dependencies: `npm install`
3. Build the MCP server: `cargo build --release -p maestro-mcp-server`
4. Run in dev mode: `npm run tauri dev`
5. Make your changes
6. Test thoroughly with multiple sessions

### Project Structure

```
maestro/
├── src/                     # React/TypeScript frontend
│   ├── components/          # UI components
│   ├── lib/                 # Utility libraries
│   └── App.tsx              # Main application
├── src-tauri/               # Tauri Rust backend
│   ├── src/
│   │   ├── commands/        # Tauri command handlers
│   │   ├── core/            # Core business logic
│   │   └── lib.rs           # Main Rust entry point
│   ├── Cargo.toml           # Rust dependencies
│   └── tauri.conf.json      # Tauri configuration
├── maestro-mcp-server/      # Rust MCP server (bundled with app)
│   ├── src/
│   │   └── main.rs          # MCP server entry point
│   └── Cargo.toml           # MCP server dependencies
├── Cargo.toml               # Workspace configuration
├── package.json             # Node.js dependencies
└── README.md
```

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- [Tauri](https://tauri.app/) - Cross-platform desktop framework
- [xterm.js](https://xtermjs.org/) - Terminal emulator for the web
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP SDK
- [Claude Code](https://claude.ai/claude-code) - AI coding assistant

---

Built with Love by Jack
