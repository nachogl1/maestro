---
name: generate-project-writeup
description: "ORION - Generate a single polished Microsoft Word (.docx) PROJECT WRITE-UP / SUMMARY REPORT for the current repository, dropped into the user's Downloads folder, written for LEADERSHIP / COMMERCIAL STAKEHOLDERS to summarise the work delivered to date. It leads with an economic case — a transparent cost comparison (a defensible traditional team x duration x blended-rate baseline, cross-referenced to the COCOMO II Post-Architecture phase model) against the ACTUAL observed delivery, headlining the savings and time-to-market compression of an AI-assisted build. The contributor count and full-time/part-time FTE split that drive the cost math are ALWAYS confirmed with the user by NAMING the real contributors — both the embedded business-unit (BU) developers/owners and the central/shared specialist delivery-team developers — with the headcount and team-origin split derived from those named lists (git author lists over/under-count bots, AI-agent commits, and part-timers). It also ALWAYS confirms the project's start and end dates with the user and shows the total elapsed duration. NEUTRAL ON COMPLETION: it describes what has been delivered without claiming the project is finished to completion or production-ready, and equally without stating it is unfinished. Up front it also asks the user for an RFA or other supporting documents (business case, original pre-build estimate, rate card, revenue figures) so the economic baseline and value sections are populated from real, cited data rather than guesses. After the financial summary it assembles: project overview (what it is, the problem solved, the solution), scale-of-work quantitative metrics measured from the real repo (LOC split prod vs test, commits, duration, modules, models, endpoints, tests, docs), technical architecture (backend/frontend/infra stack tables with rationale), architecture patterns, security implementation, core features, an 'invisible excellence' section (testing, code quality, design system), a traditional-vs-modern comparison, value delivered (risk reduction + OPEX saving; revenue only if a business case is supplied), and a documentation inventory. Detects the project's stack and conventions from its own files at run time — assumes no stack. Renders the .docx via a bundled zero-dependency Python generator (no pandoc / python-docx / Word install required), with pandoc and HTML fallbacks. INVENTS NO NUMBERS — every metric is measured or marked 'not measured'. STRICTLY READ-ONLY: it reads git + repo files and writes ONE .docx to Downloads (deleting any sidecar/temporary files it creates once the .docx is rendered); it never edits the repo and never commits. Use when the user says '/generate-project-writeup', 'generate a project write-up', 'write up a project summary report', 'project summary / status report for this project', 'project delivery summary for leadership', 'AI-assisted development summary', or wants a single shareable Word document summarising a project for leadership."
disable-model-invocation: true
---

# generate-project-writeup

> [!NOTE]
> **Editing this skill?** Keep everything in the skill
> files **general** (see the Distribution-safety gate at the bottom) — orion is
> publicly distributable. The *report* it generates about a user's repo is a local
> artifact in their Downloads and may name their project, people, and figures; the
> **skill files must never hard-code anything project-specific** (no product/codename,
> no company, no real rates, no person names).

Produce a single polished **Microsoft Word (`.docx`) project write-up / summary report**
in the user's Downloads folder that lets a delivery lead present the work delivered so far to
**leadership / commercial stakeholders** — leading with the **economic case** (what it
would traditionally have cost vs. what it actually took) and backing it with measured
scale-of-work, technical depth, and business value.

The output lives at
`~/Downloads/<repo-name>-project-writeup-<YYYY-MM-DD>.docx` (Windows:
`%USERPROFILE%\Downloads\…`) so it's instantly shareable.

## When to invoke

User says `/generate-project-writeup`, asks to **write up / summarise a project**,
wants a **delivery or project-summary report for leadership**, an **AI-assisted
development summary**, or a single shareable **Word document summarising the work delivered
so far**.

> Not to be confused with `project-handover` (a *technical* handover to a
> successor developer, HTML, dark theme) — **this** skill is an *executive/commercial
> project write-up*, Word format, economics-first.

## Operating principles (read these first)

- **Audience: leadership & commercial stakeholders.** Sponsors, a business-unit owner, a
  budget holder. Write in **clear, confident, plain business English**. Define a technical
  term the first time it appears, in one phrase, then move on. Lead with outcomes, cost,
  risk, and value; keep the deep technical detail in its own clearly-labelled sections so a
  non-technical reader can skim past it.
- **Neutral on completion — never overclaim, never underclaim.** This is a write-up of the
  work **delivered to date**, not a certificate of completion. Delivery and production-readiness
  are different things: a build can be substantively delivered yet not production-ready. So
  **do not** describe the project as "finished", "complete", "completed to completion", "closed
  out", "production-ready", or "shipped to production" — and equally **do not** state it is
  "unfinished", "incomplete", or "not done". Use neutral, factual framing: *delivered to date*,
  *built so far*, *the work covered by this report*, *current state*. Describe what exists and
  what it does; let the reader draw their own conclusion about readiness. (This wording rule
  applies to the report's title/labels, the financial summary, and every narrative section.)
- **Economics first, and HONEST.** The headline is a cost/time comparison. Every figure must
  be **defensible and its assumptions shown** — the report states the method, the rate, the
  team assumption, and the source of each number. **Never inflate.** A reader who disagrees
  with an assumption must be able to see exactly which one and re-do the math. (See
  *Economic methodology* below — it is deliberately conservative and transparent.)
- **Invent no numbers.** Every metric is **measured from the real repo** (git, file counts,
  test counts) or marked **"not measured."** Never guess LOC, test counts, velocity, commit
  counts, or revenue. If a section can't be substantiated, shrink or drop it — do not pad.
- **Contributors are always confirmed with the user — by name.** The cost math hinges on
  headcount and the full-time/part-time FTE split. Git author lists mislead (bots, AI-agent
  commits, renamed emails, drive-by contributors). **Always** show the git author list as a
  hint and **ask the user to name the real contributors** — both the embedded business-unit
  (BU) developers/owners and the central specialist-team developers — then **derive the
  headcount from those names** and ask the FTE (full-time/part-time) per person. Never let
  `git shortlog` set the count.
- **Assume no stack.** Detect build/test/run, layout, modules, models, endpoints, and test
  conventions from the project's own manifests and source at run time. Never carry another
  project's stack or vocabulary over.
- **Strictly read-only, and tidy.** The skill reads git + repo files and writes exactly
  **one `.docx` to Downloads**. Any side file it creates along the way (the report-data JSON
  sidecar, and any scratch/temporary file) is **deleted once the `.docx` is rendered and
  verified** — the run leaves behind the single Word document and nothing else. It **never
  edits the repo, never commits, never pushes.**
- **Single self-contained Word file.** No linked images, no external template the recipient
  needs. The bundled generator emits a portable `.docx`.
- **Distribution-safety self-check** before writing (see gate). The generated report is a
  local artifact and may name the user's project/people/figures; the **skill files** stay
  general.

## How the `.docx` gets generated (bundled, zero-dependency)

The skill does **not** hand-write OOXML or depend on Word. It assembles all report content
into a **single JSON file** and renders it with the bundled generator:

```
python <skill-dir>/assets/build_docx.py <report-data.json> <output.docx>
```

`build_docx.py` uses **only the Python standard library** (`zipfile` + OOXML templating) —
no `python-docx`, no `pandoc`, no Word install. The JSON contract (block types:
`title_block`, `toc`, `heading`, `paragraph`, `bullets`, `table`, `page_break`) is
documented in the **header of `build_docx.py`** — read it before authoring the JSON. The
generator handles styling (cover/title block, coloured table headers, zebra rows, an
emphasised total/savings row, a live Word table-of-contents field, headings that populate
that TOC).

**Generation path & fallbacks** (pick the first that works on the machine):

1. **Primary — `build_docx.py`** with any `python3`/`python` on PATH (3.8+). This is the
   default; it needs nothing installed. Verify Python: `python --version` (Windows often
   `py -3 --version`).
2. **Fallback A — pandoc**, *only if* Python is somehow unavailable but `pandoc` is present:
   emit the same content as Markdown and run `pandoc report.md -o output.docx`. Tables and
   headings convert; you lose the coloured cover styling.
3. **Fallback B — Word-openable HTML**, last resort: write a styled `.html` and tell the user
   to open it in Word and "Save As → .docx". Only if neither Python nor pandoc exists.

State in chat which path was used. **Do not install anything** without asking the user first.

## Inputs / pre-conditions

- A **target repository** — default to the current repo (`git rev-parse --show-toplevel`).
- **Report metadata** (for the cover/title block) — gathered from the user, with sensible
  detected defaults: project display name (repo/README), optional **codename**, one-line
  subtitle, **business unit / programme**, report **date** (default today), **project
  owner**, **confidentiality** line, and the **report-type** label (default
  *"AI-Assisted Development — Project Summary Report"*; offer a neutral
  *"Project Delivery Summary"* if the build wasn't AI-assisted).
- **Economic inputs** (prompted — see methodology):
  - **Contributors & FTE** — the user **names** the real contributors (BU developers/owners
    and central specialist-team developers); the headcount and FTE are derived from those
    names (always — see Step 4).
  - **Blended day rate + currency** — the org's internal blended cost per person-day (e.g.
    `650` + `GBP/£`). No default invented; ask.
  - **Working days per month** — default `20` (offer to change).
  - **Assumed traditional team composition** — e.g. *2 developers + 1 QA*; confirm.
  - **Project start & end dates (ALWAYS confirm)** — propose the git-derived span (first→last
    commit on the delivery branch) as a hint, then **explicitly ask the user to confirm the
    real start and end dates** (real elapsed wall-clock often differs from the commit span —
    kick-off and discovery predate the first commit; the "end" may be today / the report date).
    **Compute and show the user the total elapsed duration** (e.g. "2026-01-06 → 2026-06-03 =
    ~4.9 months / ~21 weeks") so they can see and correct it. The confirmed duration feeds the
    cover dates and the economic model's `actual_calendar_months`.
- **Supporting source documents (always offered — see Step 1b)** — proactively ask the user
  for an **RFA** (Request for Approval / funding-approval or business-case document) and **any
  other documents that carry real data** the report can use instead of being left blank:
  the original proposal / statement of work, the org's own pre-build effort/cost **estimate**
  (assumed team & duration), a **rate card**, revenue / forecast figures, security or
  compliance requirements, design specs. The user may give file paths or paste content. These
  feed the economic baseline (traditional team & duration, day rate), §Value Delivered →
  Revenue, and the problem-solved narrative — every figure still has its **source shown** and
  nothing is invented. **Optional:** if the user supplies none, proceed on detected/measured
  data and mark the affected sections **"not provided"** (revenue especially) — never
  fabricate commercial projections or estimates.

## Workflow

### Step 1 — Confirm scope & gather report metadata

1. Resolve repo root + name. Read `README.md` / `CLAUDE.md` to propose the project display
   name, subtitle, and (if present) a codename — confirm with the user.
2. Collect cover metadata (business unit/programme, date, owner, confidentiality, report-type
   label). Use `AskUserQuestion` to batch the genuine unknowns; accept sensible defaults for
   the rest and state them.
3. **Confirm the project start & end dates with the user (always).** Propose the git-derived
   span (first→last commit) as a hint, ask the user to confirm the real start and end dates,
   and **show them the computed total duration** (e.g. "2026-01-06 → 2026-06-03 ≈ 4.9 months").
   These drive the cover dates and `actual_calendar_months` in the economic model (see Step 5).
4. Decide the **delivery branch / commit range** the report measures (default: the repo's
   default branch full history; allow a date range or a base..head range if the user scopes
   the project to a window).

### Step 1b — Ask for supporting documents (RFA / business case / estimates)

The repo measures *what was built*; it rarely carries the **commercial and pre-build context**
the economic case and value sections need. So — **in addition to the other questions** — always
ask the user up front whether they can supply supporting documents, and read whatever they give
before building the economic model and the narrative:

1. **Ask explicitly** (a short prompt, or batch it with the Step 1 metadata via
   `AskUserQuestion`): *"Do you have an RFA or any other documents I can pull real data from
   for the write-up?"* Name the kinds that help most, with what each unlocks:
   - **RFA** (Request for Approval / funding-approval or business-case document) → the problem
     solved, the commercial justification, expected revenue/value.
   - **Original proposal / statement of work / pitch** → scope and the "problem we solved".
   - **The org's own pre-build estimate** (assumed team size & duration) → the **traditional
     baseline** in the cost model, so it's *their* figure, not a derived guess.
   - **Rate card / blended day rate** → the cost-per-person-day input.
   - **Revenue / forecast / pricing figures** → §Value Delivered → Revenue (only with a real
     source).
   - **Security / compliance requirements, design specs** → §Security and the solution
     narrative.
2. **Accept paths or pasted content.** If the user gives a path, read it (read-only); if they
   paste, use that. If a doc lives in the repo already (Step 2 scans for RFAs/business-case
   docs), point at it and confirm rather than re-asking.
3. **Extract data, cite the source, invent nothing.** Pull only figures/claims the document
   actually states; record each one's source (which doc) so the report stays reproducible and
   defensible. Apply the **Distribution-safety / secrets** rules — strip credentials, customer
   names, internal hostnames, etc. before they reach the report.
4. **Optional, never blocking.** If the user has nothing to share, say so and continue on
   detected/measured data, marking the affected sections **"not provided"** (revenue, the
   traditional estimate if you must derive it) rather than fabricating them.

Carry the supplied documents into Step 2 (narrative), Step 5 (economic baseline & rate), and
Step 6 §Value Delivered.

### Step 2 — Discover the project (for the narrative sections)

Read these where present and synthesize, citing nothing project-specific into the skill but
freely into the report:

1. `README.md` (root + per-package) → elevator pitch, what it is.
2. `CLAUDE.md` / `AGENTS.md` / `.claude/rules/*` → conventions, workflow (summarize, don't quote).
3. Architecture/spec docs: `ARCHITECTURE.md`, `docs/architecture/**`, ADRs / decision logs,
   `PROJECT_NOTES.md`, design specs, RFAs/business-case docs.
4. **Manifests for the exact stack** (detect, don't assume): `*.sln`/`*.csproj`, `pom.xml`,
   `build.gradle`, `Cargo.toml`, `go.mod`, `pyproject.toml`/`requirements.txt`,
   `package.json` + lockfile, `Dockerfile*`, `docker-compose*`, CI under
   `.github/workflows/**` / `.gitlab-ci.yml`. Derive the stack tables (component → technology
   → why), infra, and CI/CD shape from what's actually present.
5. Top-level layout → the real module/app boundaries, for §Architecture patterns and
   §Core features.

### Step 3 — Measure the scale of work (NUMBERS — measure, never guess)

Use read-only git + file scans. Prefer a real counter when available, else fall back. Mark
anything you can't measure as **"not measured"** in the report rather than estimating.

- **Commits & cadence** — `git rev-list --count <range>`; `git shortlog -sne <range>` (also
  feeds Step 4); first/last commit dates → **calendar duration**.
- **Lines of code, split production vs test** — prefer `cloc` or `tokei` if installed
  (`cloc --vcs=git` / `tokei`). Else use `git ls-files` filtered by extension with `wc -l`,
  and **explicitly separate** production code from **tests, migrations, generated artefacts,
  vendored deps, lockfiles** (exclude the latter from the "production SLOC" used for the cost
  model; report test LOC separately as a quality signal). Split backend vs frontend by
  directory/extension.
- **Backend structure** (stack-adaptive examples — adapt to the real stack):
  modules/apps, domain models/entities, API endpoints/routes, controllers/serializers,
  background jobs, DB migrations. Detect by grepping the real source (e.g. Django: `models.py`
  classes, `path()`/`re_path()` routes, DRF serializers; .NET: `[ApiController]`/`[Http*]`;
  Express/Nest: route decorators/`router.*`; Rails: `resources`/models). Count only what you
  can see.
- **Frontend structure** (if any): pages/views, components, routes, i18n locales, design-system
  primitives, accessibility attributes (`aria-*`/`role=`), build tool.
- **Tests** — files and **cases**: backend (`def test_` / `[Fact]`/`[Test]` / `func Test`),
  component (`it(`/`test(`), e2e (Playwright/Cypress spec counts). Compute the
  **test-to-production LOC ratio** as a quality indicator.
- **Docs** — count markdown docs + total lines; ADRs; design specs. Feeds the Appendix
  inventory (document → lines → purpose).

Record every measured value with the command/source so the report is reproducible. Put the
big set into §Scale of Work (metric → value → industry context); the "industry context"
column is a neutral one-line characterisation, **not** a fabricated benchmark.

### Step 4 — Establish contributors & FTE (ALWAYS ASK)

1. Show the user the git author list: `git shortlog -sne <range>` (counts + names/emails).
2. Flag obvious non-humans (bot accounts, `*-bot`, CI users, AI-agent commit signatures /
   `Co-Authored-By` agent trailers) as candidates to **exclude** from headcount.
3. **Ask the user to name the real contributors** (don't ask for a bare count — derive the
   count from the names), via `AskUserQuestion` or a short prompt. Ask for two named lists:
   - the **names of the embedded business-unit (BU) developers / owners**; and
   - the **names of the central / shared specialist delivery-team developers** (the dedicated
     AI or platform team some orgs run centrally — use whatever label the user gives this
     group).
   The **number of human contributors is whatever these two named lists add up to**, and the
   **BU-vs-specialist-team split** falls straight out of which list each name sits in — so you
   get the team-origin split for free, without a separate question.
4. **For each named person, ask whether they are full-time or part-time** on the project, and
   how to translate part-timers into **FTE** (default: each part-timer ≈ 0.25 FTE unless told
   otherwise) → compute total **FTE** from the named people (e.g. `3 full-time + 1 part-time =
   3 + 0.25 = 3.25 FTE`).
5. Confirm whether to **exclude AI-agent/bot commits** from the human contributor count
   (default: yes — they are the tooling, not headcount). The **named** contributors set the
   headcount, not the git author list.
6. Carry the confirmed **FTE**, **contributor count** (= number of named people), and
   **team-origin split** (BU vs. central specialist team, from the two lists) into the economic
   model and the cover/metrics. Record the assumptions explicitly in the report (e.g. a
   footnote: "3.25 FTE = 3 full-time + 1 part-time at 0.25 FTE; 3 BU developers + 1 central
   specialist-team developer").

### Step 5 — Build the economic model (centerpiece — transparent & conservative)

Gather the remaining economic inputs (Step "Inputs"): **blended day rate + currency**,
**working days/month** (default 20), **assumed traditional team**, **actual calendar months**
(from the **user-confirmed start & end dates** in Step 1 — not raw git span unless the user
accepted it).

**Economic methodology (state this method, and its assumptions, in the report).**

- **Person-month (PM) unit cost** = `day_rate × working_days_per_month`
  (e.g. £650 × 20 = £13,000 / PM). One rate held constant across scenarios for comparability.
- **Actual (delivered) effort & cost** = `FTE × actual_calendar_months` PM × PM-cost.
  This is observed delivery — the FTE from Step 4, the months from git.
- **Traditional baseline effort & cost** = `assumed_team_size × assumed_calendar_months` PM
  × PM-cost. The assumed team and duration are the **org's own pre-AI estimate** — prefer the
  figure from a document the user supplied in **Step 1b** (RFA / original estimate / proposal);
  else ask the user; if they have no figure, derive a *defensible* duration from a stated
  productivity assumption and show it. This is the headline "what it would have cost."
- **Savings** = traditional − actual, in money, in calendar time, and as a %.

**COCOMO II — use as a cross-check and for the phase split, with a caveat.** The COCOMO II
Post-Architecture *phase distribution* (Boehm's nominal split, roughly **7 / 17 / 25 / 22 /
22 / 7** across the six waterfall buckets **Plans & Requirements / Product Design / Detailed
Design / Code & Unit Test / Integration & Test / Transition** — merge Detailed Design +
Code & Unit Test into one "Programming" row if a four-row table reads better) is a sound,
citable way to break the timeline into
**Table 2 (time by phase)** for both the traditional and the actual columns. You **may** also
present a full COCOMO II effort estimate
(`PM = 2.94 × KSLOC^E`, `E ≈ 1.10` at nominal scale factors;
`schedule = 3.67 × PM^0.32`) **only if** you add the honest caveat that COCOMO II's
constants are calibrated to older, lower-productivity baselines and tend to **overestimate**
modern framework-based delivery — so treat it as a conservative upper bound, not as
corroboration of the simpler team×duration figure. **Do not force the two methods to agree;
if they diverge, say so.** Prefer the transparent team×duration figure as the headline.

Produce **Table 1 (cost comparison)** — Traditional / AI-Assisted (Actual) / Savings rows —
and **Table 2 (time by phase)**. Every number traces back to a stated input.

### Step 6 — Assemble the report content (mirror these sections)

Build the JSON `blocks` array (see `build_docx.py` header for the schema). Adapt/drop
sections the project can't substantiate rather than padding. Default structure:

1. **Title block** — banner (org / programme), project name (+ codename), subtitle, fields
   (business unit, **project start → end dates with total duration**, owner), report-type
   label, confidentiality line.
2. **Table of contents** (`toc` block) + a page break.
3. **Financial Summary** — a one-line method note; **Table 1 — Cost Comparison**; a
   "showing the working" paragraph (production SLOC measured, **the confirmed start→end dates
   and total duration**, team & rate assumptions including the **BU vs. central-specialist-team
   composition**, the arithmetic); **Table 2 — Time Investment by Phase** with the
   Boehm-distribution note.
4. **Part 1 — Project Overview** — *What is `<project>`?* (plain-language description +
   architecture in a sentence or two); *The problem we solved* (the gap/market/compliance
   need, drawn from README/RFA — only what's documented); *Our solution* (bulleted highlights).
5. **Part 2 — Scale of Work** — the quantitative metrics table (metric → value → context),
   from Step 3. Everything measured.
6. **Part 3 — Technical Architecture** — Backend / Frontend / Infrastructure stack tables
   (component → technology → why this choice), from the real manifests.
7. **Part 4 — Architecture Patterns** — the 3–5 load-bearing patterns (named heading +
   2–4 sentences each: what it is, why, the trade-off), from the real layout.
8. **Part 5 — Security Implementation** — identity/auth, transport/cookies, middleware,
   any high-risk boundary, audit trail, tenancy/isolation — only what the code actually does.
9. **Part 6 — Core Features** — a lifecycle/stages table if the domain has one, then a short
   per-module breakdown (module → what it owns → key capabilities as bullets).
10. **Part 7 — The Invisible Excellence** — Comprehensive Testing (counts + ratio), Code
    Quality (linters/formatters/CI gates), Design System / Accessibility (if frontend).
11. **Part 8 — Comparison with Traditional Approach** — a "manual/legacy vs `<project>`"
    aspect table, and an "operational efficiencies" (process → before → after → improvement)
    table. Keep "improvement" qualitative unless a real number exists.
12. **Part 9 — Value Delivered** — **Revenue opportunity** (ONLY if a business case was
    supplied; else a short "not provided — supply the business case to populate" note);
    **Risk reduction** (bulleted, grounded in the actual security/compliance/audit features);
    **OPEX / time-to-market saving** (from the economic model — restate the saving cleanly).
13. **Appendix — Documentation Inventory** — document → lines → purpose, from Step 3.

Write the JSON to a sidecar (e.g. `<output-dir>/<repo>-writeup-data.json`).

### Step 7 — Render the `.docx`

Run the primary generator (or the first working fallback):

```bash
python "<skill-dir>/assets/build_docx.py" "<data.json>" \
       "<Downloads>/<repo-name>-project-writeup-<YYYY-MM-DD>.docx"
```

- `<repo-name>` = repo name (lowercase, hyphenated) from `gh repo view --json name -q .name`
  when available, else the toplevel folder name. `<YYYY-MM-DD>` = today.
- On Windows the Python launcher is often `py -3`; the Downloads path is
  `${env:USERPROFILE}\Downloads`.

### Step 8 — Verify, then report

- Confirm the file exists and is a valid package: it's a zip whose `word/document.xml`,
  `styles.xml`, etc. parse as XML. (`build_docx.py` only emits well-formed parts, but verify
  the file was written and is non-trivial in size.)
- If Word/LibreOffice is available you may open it headless to sanity-check (optional); the
  TOC is a field — Word offers to update it on open (the bundled `settings.xml` requests it).
- Confirm UTF-8 survived (em dashes, currency symbols, accents) by reading a slice of
  `document.xml` back.
- **Report in chat:** the absolute file path, the **generation path** used (build_docx /
  pandoc / HTML), the **economic headline** (traditional vs actual vs saving, with the FTE and
  rate assumptions named), the section count, and a one-line note of anything marked
  "not measured" or "not provided." The skill ends here — it does **not** edit the repo,
  commit, or offer to.
- **Clean up side files (always).** Once the `.docx` is written and verified, **delete every
  side file the run created** — the report-data JSON sidecar and any scratch/temporary files —
  so the only artifact left behind is the single Word document. (Do this only after the `.docx`
  verifies; if generation failed, keep the JSON so the user can retry/inspect, and say so.)

## What to NOT include

- **No fabricated numbers.** Not measurable from git/files → "not measured." No invented
  revenue, ROI, benchmarks, velocity, or COCOMO figures presented as fact. No forcing two
  estimation methods to agree.
- **No credentials, secrets, internal IPs, tokens, hostnames, or customer names** — even if
  read from config or docs. Replace with `<placeholder>` or omit.
- **No verbatim CLAUDE.md / internal-doc dumps** — summarize.
- **No repo edits, commits, or "I'll fix it" offers** — the document is the deliverable.

## Failure modes to watch

- **Python not on PATH** — try `py -3`, `python3`, `python`; if truly absent, fall back to
  pandoc, then Word-openable HTML. Don't silently produce nothing.
- **Shallow / squashed clone** — commit count and duration are degraded; note the limitation
  and lean on file-based metrics. Don't present a squashed history as the real cadence.
- **Bot / AI-agent commits inflate authors** — this is exactly why Step 4 always asks. Never
  let `git shortlog` alone set headcount.
- **No business case / no supporting docs** — Step 1b always asks for an RFA or other source
  documents; if the user supplies none, leave Revenue (and any unsubstantiated baseline) as
  "not provided" and continue on measured data. Never invent projections to fill the gap.
- **Monorepo / multiple stacks** — scope LOC and module counts per package and say so; don't
  blend a backend and an unrelated tool into one SLOC figure used for cost.
- **Generated/vendored code dwarfs hand-written** — exclude it from production SLOC or the
  cost model is meaningless; state the exclusions.
- **PowerShell encoding** — if you ever write text parts yourself (HTML fallback), avoid a
  BOM (PowerShell 5.1's `-Encoding utf8` adds one): use `[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding $false))` (`$path` must be absolute, e.g. `(Join-Path (Get-Location) '<file>')`, because .NET resolves relative paths against its own current directory, not PowerShell's).
  `build_docx.py` already writes UTF-8 without BOM.

---

## Distribution-safety gate (orion is publicly distributable)

This skill ships publicly. Before generating, confirm **nothing project-specific leaked into
the skill files** — no person/org/product/codename/repo/stack/rate/locale/path specifics in
prose, examples, or the generator. The **generated report** about a user's repo is a **local
artifact** (in their Downloads) and may name their project, people, business unit, rates, and
figures — that's expected; it is never committed back into the project. What must stay general
is the skill's own files (including any example JSON
or rates in `build_docx.py` — keep them neutral placeholders).
