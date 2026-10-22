---
name: project-handover
description: "ORION - Generate a single self-contained dark-themed HTML PROJECT HANDOVER document for the current repository, dropped into the user's Downloads folder, written for a BROAD audience — clients and stakeholders as well as a brand-new joiner — assuming zero knowledge of the tech stack and zero knowledge of the domain, explained in plain language, summarised and clear (every stack/domain term defined on first use). NEUTRAL TONE: the document is addressed to nobody, by nobody — no 'I', no named author, no named successor, no departing-engineer framing or personal ownership. NO CODE INTERNALS: it describes the project at the level of general product behaviour, modules, and features — it never names classes or describes how classes/code wire together (code is often agent-generated and that detail is neither known nor stable). NO STALE-PRONE CONTENT: it deliberately omits open PRs, open branches, work-in-progress, and 'what to pick up next' — anything that flips within a day. The one status it carries is a DATED epics-and-stories snapshot: it lists every epic and every story with a short plain description and a done/not-done badge (green = done, red = not done). The doc is a scrolling reference page with a sticky table-of-contents: cover, TL;DR/overview, product & domain context, architecture & mental model WITH conceptual diagrams built as styled HTML/CSS (boxes + labelled arrows — never ASCII art) of the general components/modules and how they broadly interconnect plus a request/data-flow diagram for one core user action (all at product/behaviour level, no class or file names), how it's built & run (auto-detected setup/build/test/run, kept technical but module/feature-level), the full epics & stories listing with badges, and a glossary. Detects the project's stack and its backlog source (BMAD story docs / GitHub Issues / Jira — whichever it actually uses) at run time; assumes no stack. PRODUCT DEPTH: it runs its own exhaustive product discovery (problem solved, users, domain vocabulary, end-to-end user journeys, this repository's role) and distils it into plain, neutral, product-level language. STRICTLY READ-ONLY: it reads git + repo files + the tracker and writes its handover HTML file to Downloads; it never edits the repo and never commits. Use when the user says '/project-handover', 'create a handover', 'hand this project over', or wants a single shareable HTML file that explains the project and the delivery state of its epics and stories."
disable-model-invocation: true
---

# project-handover

> [!NOTE]
> **Editing this skill?** Keep everything here
> **general** (see the Distribution-safety gate below) — orion is publicly
> distributable. The *report* it generates about a user's repo is a local artifact
> and may name their repo; the skill files must never hard-code anything
> project-specific.

Produce a single self-contained dark-themed **HTML handover document** in the user's
Downloads folder that takes **any reader — including clients and non-technical
stakeholders, as well as a brand-new joiner** — from "I've never seen this project" to
"I understand what it is, what it does, how it's broadly built, and the delivery state
of every epic and story."

The output is a **scrolling reference page with a sticky table-of-contents** (not a
slide deck) — readers will search it and return to it, so anchored, scannable sections
beat one-pass slides. It lives at
`~/Downloads/<repo-name>-handover-<YYYY-MM-DD>.html` (Windows:
`%USERPROFILE%\Downloads\…`) so it's instantly shareable.

## When to invoke

User says `/project-handover`, asks to **create a handover** / **hand the project
over**, or wants a single shareable HTML file that explains the project and the delivery
state of its epics and stories.

## Operating principles (read these first)

- **Audience is broad and includes clients.** Write for someone with **zero knowledge of
  this project's tech stack and zero knowledge of the domain** — a client, a stakeholder,
  or a brand-new joiner. Plain, friendly language; define **every** stack term, library,
  acronym, and domain word on first use; reach for a simple analogy when it helps. Never
  assume the reader knows a framework, tool, or business concept.
- **Neutral tone — addressed to nobody, by nobody.** This is **not** a personal hand-off
  and **not** an offboarding note. There is **no "I"**, no named author, no named
  successor, no "departing engineer," no "areas I owned," no "what you should pick up."
  Write it as a standing description of the project that would read the same whoever
  produced it and whoever reads it.
- **No code internals — describe behaviour, modules, and features.** The codebase is
  often agent-generated, so the exact classes and how they wire together are neither known
  nor stable, and they're hard for a reader to follow. So: **never name classes, never
  cite file paths, never describe how classes/code connect internally.** Speak in terms of
  **general product behaviour**, **modules**, and **features** (these *may* be named). Turn
  any code detail you read into product/behaviour language before it reaches the doc.
- **No stale-prone content.** Deliberately **omit** open PRs, open branches,
  work-in-progress, stashes, and any "next steps / what to do first" — these flip within a
  day and would leave the document wrong by the evening. The **only** status the doc
  carries is a **dated epics-and-stories snapshot** (done vs. not done), at epic/story
  granularity — never drilling down into PRs or branches.
- **Whole-project, impersonal.** The thing being described is the project itself, as it
  stands, for a wide audience — not one person's contribution to it.
- **Source of truth = the repo + its backlog.** Read repo files for product, domain, and
  the general architecture; read the project's **backlog source — BMAD story docs, GitHub
  Issues, or Jira, whichever it actually uses (detect at run time)** — for the epics, the
  stories, and their done/not-done status. **Do not invent.** Mark anything not tracked as
  "not tracked."
- **Go deep on product & domain.** The product & domain section should read as a
  substantial, example-led explanation, not a thin paragraph. To get there, run an
  exhaustive product discovery (the problem it solves, who uses it, the domain vocabulary,
  the core end-to-end user journeys, what this repository is responsible for) — then
  **distill that material into the handover's voice**: strip every file path, class name,
  and code internal; keep it impersonal (no ownership or personal framing); and rewrite
  plainly for a broad, client-facing audience (see Step 2b).
- **Strictly read-only.** The skill reads git, repo files, and the tracker, and writes
  exactly **one handover HTML file to Downloads**. It **never edits the repo, never
  commits, never pushes.**
- **Assume no stack.** Detect build/test/run commands, layout, and the backlog source from
  the project's own files at run time. Never carry another project's stack or vocabulary
  over.
- **Output is a single HTML file.** No external assets, no network-loaded CSS. All styles
  and scripts inline so the file is portable and shareable.
- **Distribution-safety self-check** before writing (see gate). The generated report is a
  local artifact and may name the user's repo; the **skill files** must stay general.

## Inputs / pre-conditions

- A **target repository** — default to the current working directory's repo
  (`git rev-parse --show-toplevel`).
- A **backlog source** — detected at run time (BMAD story docs / GitHub Issues / Jira).
  If none is present, the epics-and-stories section degrades to whatever structured units
  exist and marks the rest "not tracked."
- **GitHub / Jira** — optional, used only to read epic/story status when present.
- **No personal inputs.** The skill does **not** ask for or use an author identity, a
  departing-engineer email, or a successor name — the document is impersonal.

## Workflow

### Step 1 — Confirm scope (brief)

1. Resolve the repo root and name (filename + headings only — a local artifact).
2. **Detect the backlog source** the project actually uses — BMAD story docs
   (`docs/stories/**`, `_bmad-output/**`, epic/PRD shards), GitHub Issues
   (milestones / epic labels / parent issues + issues), or Jira. State which one the
   epics-and-stories section will be built from and where status comes from.
3. State the plan in one line and proceed. Use `AskUserQuestion` only if something is
   genuinely ambiguous (e.g. two plausible backlog sources both populated).

### Step 2 — Discover the project (product, domain, general architecture)

Read these in order (some won't exist) and synthesize at the **module / feature /
behaviour** level — **translate any class or file detail into product language; never
carry class names or paths into the doc**:

1. `CLAUDE.md` / `AGENTS.md` / `.claude/rules/*.md` → ground rules, conventions.
2. `README.md` (root + per-package) → elevator pitch, what the project is.
3. Architecture / spec docs: `ARCHITECTURE.md`, `prd.md`, `product-brief*.md`,
   `docs/architecture/**`, `docs/prd/**`, `docs/design/**`, `_bmad-output/**`, ADRs.
4. Top-level layout → read it to understand the **modules and features** and how the
   product is broadly organized — **not** to expose file paths in the doc.
5. **Manifests for the stack & commands** (detect, don't assume): `*.sln`/`*.csproj`,
   `pom.xml`, `build.gradle`, `Cargo.toml`, `go.mod`, `pyproject.toml`/`requirements.txt`,
   `package.json`+lockfile, `Makefile`, `Taskfile`. Derive **setup / build / test / run /
   lint** commands from what's present, and name the **stack at a high level** (languages,
   frameworks, major services).
6. CI: `.github/workflows/**`, `.gitlab-ci.yml`, `azure-pipelines.yml` → how it ships, in
   plain terms.

Synthesize: **product & domain** (what problem it solves, who uses it, vocabulary), the
**general architecture** (the major components/modules, what each does for the product,
and how they broadly interconnect — behaviour, not code), and the **dev environment**
(setup/build/test/run, conventions).

### Step 2b — Deepen the product & domain

The handover's **Product & domain context (§3)**, its **TL;DR (§2)**, and its
**Glossary (§7)** should carry real depth — not a thin paragraph. To get there, run a
deliberate product discovery pass, then fold the result into the handover under the
handover's own rules.

1. **Run the product discovery.** Read the README, any product/PRD/architecture docs,
   user-facing routes/screens/commands, domain models, and the backlog's epic titles to
   build a far richer picture: the problem the product solves, who uses it, the domain
   vocabulary, the core **end-to-end user journeys**, the personas, and what this
   repository is responsible for within the wider system. Reading only — nothing is
   written to the repo.
2. **Distill, then re-filter through the handover's rules.** Discovery notes will
   naturally cite file paths, code, and who-owns-what. **None of that may reach the
   handover.** Translate every point into **product / behaviour language** (no class
   names, no file paths, no code wiring), drop all ownership / personal framing so it
   reads **neutrally — by nobody, to nobody** — and rewrite plainly for a **broad,
   client-facing** audience.
3. **Fold it into §2 / §3 / §7.** Use the deepened material to enrich the **TL;DR (§2)**,
   the **Product & domain context (§3)** — now a proper, example-led explanation of what
   the product does, who it's for, the problem it solves, the core user journeys in plain
   terms, and the domain words a newcomer would stumble on — and the **Glossary (§7)**.
   Keep every example at the **feature / behaviour** level (a real screen, a real user
   journey, a real capability), never "see `<file>`".
4. **One handover file.** The handover emits exactly **one** handover HTML document and
   never embeds or links machine-specific paths into itself.

### Step 3 — Gather the epics & stories + their status

From the backlog source detected in Step 1. **Read-only.** For each unit capture:
**title**, a **one-line plain-English description**, and **done / not done**.

- **BMAD story docs** — group stories under their epics (from epic/PRD shards or folder
  structure). Status from each story's status field: a clearly-completed state
  (Done / Completed / Approved-and-merged) → **done**; anything else → **not done**.
- **GitHub Issues** — epics = milestones, epic-labelled issues, or parent issues; stories
  = the issues (and sub-issues / task-list items) under them. **Closed → done; open → not
  done.** Use `--limit 500` (or higher) so nothing is truncated.
- **Jira** — epics + their child stories via JQL; **status category Done → done**, else
  not done. Page through all results.

Roll up a per-epic count (e.g. "3 / 5 stories done"). If an in-progress state is clearly
distinguished by the tracker you *may* mark it separately (amber), but the default is the
**two states the document is built around: done (green) / not done (red)**. **Never
fabricate** — if there is no structured backlog, say so and mark units "not tracked."

### Step 4 — Generate the HTML (sections)

One self-contained scrolling page with a **sticky table-of-contents** linking to each
`<section id="…">`. Adapt sections to the project (drop what doesn't apply rather than
fabricate). Default sections:

1. **Cover / header** — project name, "Project Handover", the date, and a small **status
   note**: which backlog source the epic/story snapshot was built from and that it
   reflects that date. **No author, no successor, no personal framing.**
2. **TL;DR / overview** — 3–5 sentences: what the project is, what it does, who it's for,
   and the **overall delivery state in one line** (e.g. "X of Y epics complete as of
   <date>"). No "things to pick up."
3. **Product & domain context** — build this from the **deepened discovery in Step 2b**, so
   it reads as a substantial, example-led section rather than a thin paragraph: in plain
   language, what the product *does*, who uses it, the problem it solves, the **core user
   journeys** narrated in product terms, and the handful of domain words a newcomer would
   stumble on — each defined in one line with a real, **product-level** example (a feature or
   behaviour, never a class or file).
4. **Architecture & mental model (lead with diagrams)** — the stack named and **each piece
   explained in plain English** (what it is → what it does for the product), the major
   components/modules, and the load-bearing ideas (the *why*). **Include conceptual
   diagrams** so a reader sees the shape before the words:
   - a **top-level component diagram** — the major building blocks drawn as **boxes with
     labelled arrows** showing how they broadly interconnect and which way data/requests
     flow. **Name the actual technologies, services, and tools the project uses** beside
     each block, so a reader can attach the abstract role to something concrete and
     recognisable — detect them from the manifests, config, compose/IaC, and CI at run
     time. Give each box its **role *and* the real tool**, e.g. "Sign-in / identity
     (Keycloak)", "Web UI (React)", "API service (ASP.NET)", "Data store (PostgreSQL)",
     "Cache (Redis)", "Background jobs (the project's queue/runner)", "Object storage
     (S3)". This naming of **real third-party services, infrastructure, and frameworks** is
     wanted here — it is *not* the same as exposing internal code: **still never name the
     project's own classes, file paths, or how its code wires together.** If a block's tool
     genuinely can't be determined, label the role alone rather than guess. **Avoid
     super-generic, association-free diagrams** (bare "Frontend → Backend → Database" with
     no named tools);
   - a **request / data-flow diagram** for one core user action, described in **product
     terms** — "a user submits X → the system validates and stores it → notifies Y →
     returns a result" — tracing one path end to end.
   Build them as **HTML/CSS diagrams — never ASCII art in `<pre><code>` blocks**: styled
   boxes (flexbox/grid `<div>`s using the document's theme) connected by labelled arrows
   (CSS connectors or small inline SVG), with a tiny legend. Everything stays inline so the
   file remains self-contained, and the diagram renders crisply for a client-facing
   document at any width. The **component diagram names the real services/tools** (as
   above); the **data-flow diagram stays in product terms**. In **either** diagram, **never name the project's own classes,
   file paths, or internal code wiring** — naming a third-party service or framework is
   fine; exposing internal code is not. Add a third diagram only if it genuinely clarifies.
   Follow each with 2–3 plain-English sentences explaining what it shows.
5. **How it's built & run** — kept **technical but module/feature-level**: the stack named
   at a high level and explained plainly; auto-detected **setup / build / test / run**
   commands with a one-line note on what each does; conventions (branching, CI) in plain
   terms. **No "where files live" map, no class names, no paths** — describe the
   module/feature organization generally if useful.
6. **Epics & Stories** — the heart of the document. **List every epic**, each with a short
   description, a **done/not-done badge**, and a per-epic roll-up (e.g. "3 / 5 done"); under
   each epic, **list its stories**, each with a short description and its own badge.
   **Green = done, red = not done** (optional amber = in progress only if the tracker
   clearly distinguishes it). Carry the snapshot date. This is the **only** status content
   — keep it at epic/story granularity; never drill into PRs or branches.
7. **Glossary** — every stack term, library, acronym, and domain word a newcomer would not
   know, each with a one-line plain-English definition. **Product/behaviour terms only — no
   class names.** Err toward including a term rather than assuming it's obvious.

### Step 5 — Visual + technical conventions

- **Dark theme** (match the other orion report skills):
  - `--bg: #0b1020`, `--bg-2: #121933`, radial-gradient background
  - `--accent: #5cc8ff`, `--accent-2: #b08cff`, `--good: #4ade80`, `--warn: #fbbf24`,
    `--danger: #f87171`
  - Font: system sans-serif; code: JetBrains Mono / `ui-monospace` fallback
- **Layout: scrolling page, not a deck.** A **sticky table-of-contents** (sidebar on wide
  screens, collapsing to a top bar on narrow) with anchor links to each `<section id>`.
  Implement **scroll-spy** in inline JS to highlight the current section. Smooth in-page
  anchor scrolling. No keyboard slide navigation — it's a document.
- **Status badges** for §Epics & Stories — `.badge-done` (`--good`, green) and
  `.badge-todo` (`--danger`, red); optional `.badge-wip` (`--warn`, amber) only when the
  tracker distinguishes in-progress. Small, pill-shaped, with a text label
  ("Done" / "Not done") so they're legible without relying on colour alone.
- **HTML diagrams, not ASCII.** Diagrams are built from **inline HTML/CSS** — styled boxes
  (flexbox/grid `<div>`s themed with the palette above) plus labelled arrow connectors (CSS
  or small inline SVG) — **never ASCII art in `<pre><code>` blocks**. Each carries a tiny
  legend and a 2–3 sentence plain-English caption; all styles inline so the file stays
  self-contained. §4 must carry at least a **top-level component diagram** and a
  **request/data-flow diagram**. The **component diagram names the real
  technologies/services/tools** beside each block (e.g. sign-in → Keycloak, data store →
  PostgreSQL) so blocks are concrete and recognisable, detected from the repo at run time;
  the **data-flow diagram stays in product terms**. In both, **never name the project's own
  classes, file paths, or internal code wiring** — naming third-party services/frameworks
  is wanted, exposing internal code is not.
- **Language = English** regardless of the project's doc language; gloss native terms on
  first use as `<native term> (English gloss)`.

### Step 6 — Write the file

Output path:
- Linux/macOS: `~/Downloads/<repo-name>-handover-<YYYY-MM-DD>.html`
- Windows: `${env:USERPROFILE}\Downloads\<repo-name>-handover-<YYYY-MM-DD>.html`

`<repo-name>` = repo name (lowercase, hyphenated), from `gh repo view --json name -q .name`
when available, else the toplevel folder name. `<YYYY-MM-DD>` = today.

### Step 7 — Verify, then report

- Read the file back briefly: valid HTML, every TOC link resolves to a real `<section id>`,
  scroll-spy script present, every epic/story carries a badge.
- Confirm no markdown escapes leaked into HTML (no raw `**bold**`, `# headings`).
- Confirm no class names, file paths, open-PR/branch references, or personal "I/you"
  framing slipped in — the doc must read neutrally and at product level.
- Confirm UTF-8 survived — accents, em dashes, arrows render when read back.
- On Windows, if a PowerShell write added a BOM / double-encoded, re-write it without BOM:
  ```powershell
  # $path must be absolute, e.g. (Join-Path (Get-Location) '<file>'): .NET resolves relative paths
  # against its own current directory, not PowerShell's
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding $false))
  ```
- **Report in chat:** absolute file path, the **backlog source** used and the snapshot
  date, the section count, and the **epic/story roll-up** (e.g. "X of Y epics, M of N
  stories done"). The skill ends here — it does **not** edit the repo, commit, or offer to.

## What to NOT include

- **No personal / ownership framing.** No "I", no named author, no successor, no departing
  engineer, no "areas owned," no "what to pick up next." The document is addressed to
  nobody, by nobody.
- **No stale-prone pointers.** No open PRs, open branches, work-in-progress, stashes, or
  next-steps lists. The dated epic/story done-vs-not snapshot is the only status content.
- **No code internals.** No class names, no file paths, no description of how classes/code
  wire together. Module/feature names and general product behaviour only. (Naming the
  **real third-party services, frameworks, and tools** in the stack — e.g. Keycloak,
  PostgreSQL, Redis — in the §4 component diagram is *encouraged*; that is not a code
  internal.)
- **No fabricated numbers / status.** Not in the tracker/manifests → mark "not tracked."
  Never guess counts or completion.
- **No credentials, secrets, internal IPs, tokens, VPN configs, or production hostnames** —
  even if read from config. Replace with `<placeholder>` or omit.
- **No contacts / people lists** — the document is neutral and impersonal.
- **No verbatim CLAUDE.md / CONTRIBUTING content** — summarize.
- **No repo edits, commits, or "I'll fix it" offers** — the doc is the deliverable.

## Failure modes to watch

- **PowerShell 5.1 `-Encoding utf8` adds a BOM / may double-encode.** Use
  `[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding $false))` (`$path` must be absolute, e.g. `(Join-Path (Get-Location) '<file>')`, because .NET resolves relative paths against its own current directory, not PowerShell's).
- **No structured backlog detected** — say so plainly; build §Epics & Stories from whatever
  structured units exist (milestones, top-level spec docs) and mark the rest "not tracked."
  Do not fabricate epics or stories.
- **Tracker lists truncated** — always pass `--limit 500` (or higher) / page through all
  Jira results.
- **Ambiguous story status** — map conservatively: mark **done** only when the source
  clearly says done; everything else is **not done**. Don't guess.
- **Tempted to name a class or file** — translate it into module / feature / behaviour
  language instead; the reader can't use class names and they go stale.
- **Tempted to draw diagrams as ASCII art** — don't. ASCII in `<pre>` blocks breaks at
  narrow widths, looks unpolished to a client audience, and can't use the theme. Build
  diagrams as **styled HTML/CSS boxes with labelled arrow connectors** (or small inline
  SVG), keeping everything inline so the file stays self-contained.
- **Super-generic component diagram** — a bare "Frontend → Backend → Database" with no
  named tools gives the reader nothing to associate. Name the **real services/tools** beside
  each block (sign-in → Keycloak, data store → PostgreSQL, cache → Redis), detected from the
  manifests/config/compose/CI. Only fall back to a role-only label when the tool truly can't
  be determined — never guess one.
- **No architecture/PRD docs** — describe the architecture from entry points at the
  **module / feature / behaviour** level (still no class names, still no paths); keep the
  diagrams conceptual.
- **Discovery framing leaking in** — discovery notes cite file paths and code and
  name who owns what. **None of that may survive into the handover.** Translate to
  product / behaviour language, strip the ownership / personal voice, and keep it neutral and
  client-facing before it reaches §2 / §3 / §7.
- **Multi-language docs** — translate to English on first use, keep the original term in
  parentheses so it can be grepped later.

---

## Distribution-safety gate (orion is publicly distributable)

This skill ships publicly. Before writing the report, confirm **nothing project-specific
leaked into the skill files** — no person/org/product/repo/stack/locale/path specifics in
prose or examples, and every diagram/example here uses **generic component/module
placeholders, never real class or file names**. The **generated report** about a user's
repo is a **local artifact** (in their Downloads) and may name their repo and its
modules/features — that's fine; it is never committed back into the project. What must stay
general is the skill's own files.
