---
layout: default
title: Installation
nav_order: 2
---

# Installation
{: .no_toc }

Maestro has a ready-made installer for Windows and macOS. On Linux you build it yourself once.
{: .fs-5 .fw-300 }

1. TOC
{:toc}

---

## What you need first

Maestro is the screen around your AI coding sessions; the sessions themselves are Claude Code. Install these once:

- **Git**, from [git-scm.com](https://git-scm.com/downloads). Maestro uses it for branches and worktrees (separate
  checkout folders of the same repository).
- **Claude Code**. With [Node.js](https://nodejs.org/) installed, open a terminal and run:

  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

- **The GitHub CLI** (optional), from [cli.github.com](https://cli.github.com/), signed in with `gh auth login`.
  It powers the pull requests, issues and issue map.

{: .note }
Without Claude Code you can still open plain shell terminals in Maestro.

---

## Windows

1. Open the [latest release](https://github.com/nachogl1/maestro/releases/latest) and download the `.msi` file.
2. Double-click it and follow the steps. If Windows shows "Windows protected your PC", click **More info**, then
   **Run anyway**: the installer is not signed with a paid code-signing certificate.
3. Open **Maestro** from the Start menu.

Maestro needs WebView2, which Windows 10 (21H2 or later) and Windows 11 already have. On older versions,
[download WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) first.

---

## macOS

1. Open the [latest release](https://github.com/nachogl1/maestro/releases/latest) and download the
   `_universal.dmg` file. It runs on Apple silicon and Intel Macs with macOS 10.15 or later.
2. Double-click the `.dmg`, then drag **Maestro** into the **Applications** folder.
3. **First launch only.** Maestro is not registered with Apple, so macOS blocks it the first time with a message
   such as "Maestro cannot be opened" or "Maestro is damaged". The app is fine. Open the Terminal app and run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Maestro.app
   ```

   Or try to open Maestro once, then go to **System Settings → Privacy & Security**, scroll down and click
   **Open Anyway**.
4. Open **Maestro** from Applications or Launchpad. You will not need step 3 again.

---

## Updates

On Windows and macOS, updates arrive inside the app: Maestro checks for a new release and offers
**Download and Install**. You can also check by hand in **Settings → Updates**, or let Maestro install updates when
it starts. If terminals are open, Maestro warns you first, because an update closes them; they come back on their
own after the restart.

---

## Linux: build it yourself

There is no Linux installer. You build Maestro once on your own computer; the first build takes 10 to 20 minutes.

### 1. Install the tools

- **Node.js** 20 or newer, from [nodejs.org](https://nodejs.org/).
- **Rust** 1.89 or newer, from [rustup.rs](https://rustup.rs/). Use rustup rather than your distribution's package,
  which is often older.
- **Git** and **Claude Code**, as in [What you need first](#what-you-need-first).
- The system libraries, for your distribution:

  Ubuntu or Debian:

  ```bash
  sudo apt-get update
  sudo apt-get install -y build-essential pkg-config libssl-dev \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    libfontconfig1-dev patchelf
  ```

  Fedora:

  ```bash
  sudo dnf install gcc-c++ pkg-config openssl-devel webkit2gtk4.1-devel \
    libappindicator-gtk3-devel librsvg2-devel
  ```

  Arch:

  ```bash
  sudo pacman -S base-devel pkgconf openssl webkit2gtk-4.1 libappindicator-gtk3 librsvg
  ```

Close and reopen your terminal afterwards so it finds the new tools.

### 2. Get the code

```bash
git clone https://github.com/nachogl1/maestro.git
cd maestro
```

Or download the ZIP from the [repository page](https://github.com/nachogl1/maestro) (**Code → Download ZIP**)
and open a terminal in the unzipped folder.

### 3. Build

Run these one at a time, waiting for each to finish:

```bash
npm install
cargo build --release -p maestro-mcp-server
npm run tauri build
```

The second command builds Maestro's status server, which the app bundles.

### 4. Install

The packages are in `target/release/bundle/` inside the Maestro folder. Install the `.deb`, `.rpm` or `.AppImage`
that suits your system, then open **Maestro** from your app launcher.

There is no Linux release, so a self-built Maestro gets no in-app updates: to update, run `git pull` in the folder
and repeat steps 3 and 4.

---

## First steps

1. Click **+** in the tab bar and choose a project folder, ideally one that already uses Git.
2. Press **Ctrl+T** (**Cmd+T** on a Mac), name the terminal, choose Claude Code or a plain shell, and press
   **Enter** to start it.
3. Add more terminals the same way, and watch their status: Maestro shows which ones are working and which are
   waiting for you.

See [Features]({% link features.md %}) for everything else, and [Troubleshooting]({% link troubleshooting.md %}) if
something does not start.
