---
layout: default
title: Privacy
nav_order: 5
---

# Privacy
{: .no_toc }

What Maestro sends, where it goes, and how to switch it off.
{: .fs-5 .fw-300 }

1. TOC
{:toc}

---

## The short version

- Maestro runs on your computer. It has **no server of its own** and **no telemetry**: it does not count, track or
  report how you use it.
- Three features send text to Claude: **Workshop**, **History summaries** and the **Work Journal**. Each one asks you
  first, stays off until you say yes, and can be switched off at any time.
- Everything sent to Claude goes through **your own Claude CLI**, signed in with your own account, and uses **your own
  Claude allowance**.

## What goes to Claude, and when

| Feature | What Claude reads | When | Switch |
|---|---|---|---|
| Workshop | The text of your past week's Claude conversations, to write a report on what to improve | Shortly after Maestro starts, then once a week, and when you click **Run now** | **Settings → Privacy** |
| History summaries | Each conversation shown in History, to write its name and a two-sentence summary | When a conversation is shown, and again when it changes | **Settings → Privacy** |
| Work Journal | Your activity: your Claude prompts, commit messages, pull request and issue titles, and terminal names, to suggest entries | About every hour while Maestro is open | **Settings → Work Journal** |
| Work Journal report and spelling fix | The day pages in the range you pick, or the text you ask to fix | Only when you click to make a report or fix spelling | **Settings → Work Journal** |

- The first time you open Maestro, it asks once about Workshop and History summaries together, with both off. Closing
  the question keeps both off.
- The Work Journal asks separately, and stays off unless you click **Enable**.
- Switched off, Workshop starts no run and History shows each conversation's title or first prompt with no summary.
  Reports and summaries already made are kept, never deleted.

## Every outside service Maestro contacts

Apart from the features above, Maestro reaches these places, and nothing else:

- **Anthropic, through your Claude CLI.** Every Claude Code session you run in Maestro is the Claude CLI talking to
  Anthropic, exactly as it would in any other terminal.
- **Anthropic's usage address** (`api.anthropic.com`). The usage bar at the bottom of the window asks it about once a
  minute how much of your Claude allowance is left. It sends your Claude login, read from Claude Code's own saved
  sign-in, and no conversation text. This one has no off switch today.
- **GitHub, through the GitHub CLI** (`gh`). Pull requests, issues and the issue map come from GitHub through your own
  signed-in GitHub CLI.
- **Your git remotes, through git.** Fetching, pushing and deleting a remote branch go to whatever remote your project
  uses, through your own git.
- **GitHub Releases, for updates** (`github.com/nachogl1/maestro/releases`). Maestro checks there for a new version and
  downloads it from there. Turn off **Auto-check** in **Settings → Updates** to check only when you ask.
- **GitHub, for the plugin marketplace** (`raw.githubusercontent.com`). Only when you refresh the marketplace, Maestro
  reads each marketplace's plugin list; installing a plugin copies its repository with git.
- **Granola, only if you add it.** When you have connected Granola in your Claude setup, the Work Journal's Claude run
  reads your meeting notes from Granola through your Claude CLI. Maestro itself never contacts Granola.

## What stays on your computer

Your settings, Work Journal pages, Workshop reports and History summaries are saved on your computer only. Maestro
uploads none of them to a server; the only text that leaves is what the features above send to Claude.
