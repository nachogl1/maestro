# Changelog — generate-project-writeup

Record notable changes here.

## Unreleased

- **Added `VERIFY.md`**: read-only checks for git, Python 3.8+, the bundled generator and the Downloads folder.
- **Renamed to `generate-project-writeup`** (the `-orion` suffix is dropped) and the
  description now starts with `ORION -` so the origin stays visible in skill listings.
- **COCOMO phase split disambiguated.** The nominal 7/17/25/22/22/7 split listed six
  percentages against four phase names; the six waterfall buckets are now named
  (Plans & Requirements / Product Design / Detailed Design / Code & Unit Test /
  Integration & Test / Transition), with an explicit note that Detailed Design +
  Code & Unit Test may merge into one "Programming" row for a four-row Table 2.
- **Name the contributors, derive the count (Step 4).** Instead of asking for a bare contributor
  count, the skill now asks the user to **name** the real contributors as two lists — the
  embedded business-unit (BU) developers/owners and the central/shared specialist delivery-team
  developers — and derives the headcount and the BU-vs-specialist team-origin split from those
  lists. It then asks **per named person** whether they are full-time or part-time to compute
  FTE. Updated the contributors operating principle, the Inputs list, Step 4, and the frontmatter
  description. (Group labels stay generic per the distribution-safety rule — no specific team
  name baked into the skill.)
- **Always clean up side files.** The skill now **deletes** every side file it creates (the
  report-data JSON sidecar and any scratch/temporary files) once the `.docx` is rendered and
  verified, leaving only the single Word document — previously it merely *offered* to delete the
  sidecar. If generation fails, the JSON is kept for retry/inspection. Updated the read-only
  operating principle, Step 8, and the frontmatter description.
- **Neutral on completion (tone).** The skill no longer frames the output as a "closure"
  report or implies the project is finished / production-ready — but equally never states it is
  unfinished. New operating principle bans completion/production-readiness claims ("finished",
  "complete", "closed out", "production-ready") *and* their inverse ("unfinished", "not done"),
  in favour of neutral framing ("delivered to date", "current state", "the work covered by this
  report"). Reframed the frontmatter description, intro, and "When to invoke" from
  closure/"marks the project as delivered" to a project write-up / summary of work delivered.
- **Always confirm project start & end dates and show the total duration.** Step 1 now
  explicitly confirms the real start/end dates with the user (git span shown only as a hint) and
  displays the computed total elapsed duration, which feeds the cover dates and the economic
  model's `actual_calendar_months` (Step 5). Updated the Inputs list and the title-block /
  financial-summary content to carry the dates + duration.
- **Capture contributor team-origin (BU vs. central specialist team).** Step 4 now also asks
  which contributors are embedded business-unit (BU) developers vs. members of a central/shared
  specialist delivery team, and records the split in the cover/metrics and financial-summary
  working. Labels adapt to whatever the user calls these groups (kept generic per the
  distribution-safety rule — no specific team name baked into the skill).
- **New Step 1b — ask for an RFA / supporting documents up front.** In addition to the
  existing metadata and economic questions, the skill now proactively asks the user for an
  **RFA** (Request for Approval / business-case doc) and any other source documents that carry
  real data — original proposal / statement of work, the org's own pre-build estimate (assumed
  team & duration), a rate card, revenue/forecast figures, security/compliance requirements,
  design specs. Supplied docs (path or pasted) feed the economic baseline (traditional team &
  rate), the problem-solved narrative, and §Value Delivered → Revenue. Data is **extracted and
  cited, never invented**; secrets/customer names are stripped; the ask is **optional and
  non-blocking** — with nothing supplied the affected sections stay "not provided." Updated the
  Inputs list, Step 5 (traditional baseline prefers a supplied estimate), the "no business
  case" failure mode, and the frontmatter description to match.

## Initial

- New skill: generate a single polished **Microsoft Word (`.docx`) project write-up / closure
  summary report** into the user's Downloads folder
  (`~/Downloads/<repo-name>-project-writeup-<YYYY-MM-DD>.docx`).
- **Audience: leadership / commercial stakeholders** — a closure/delivery write-up that marks
  a project as done, in clear business English (not a technical successor handover — that's
  `project-handover`).
- **Economics-first, transparent, and honest.** Headlines a cost comparison: a defensible
  *traditional team × duration × blended-rate* baseline vs. the **actual observed delivery**
  (FTE × calendar months), with money/time/% savings. Uses the **COCOMO II Post-Architecture
  phase distribution** (Boehm 7/17/25/22/22/7) for the time-by-phase table, and allows a full
  COCOMO II effort estimate only with the honest caveat that its constants over-estimate
  modern framework delivery. Every figure traces back to a stated, user-confirmable assumption.
- **Contributor count + FTE split are always confirmed with the user** — git author lists
  (`git shortlog -sne`) are shown as a hint, but bots, AI-agent commits, and part-timers mean
  headcount and the full-time/part-time FTE split are explicitly asked for and recorded.
- **Invents no numbers** — every scale-of-work metric (LOC split production-vs-test, commits,
  duration, modules/models/endpoints, tests, docs) is **measured from the real repo** or
  marked "not measured." Revenue is only populated from a user-supplied business case, else
  "not provided."
- Mirrors a full executive report structure: title block, table of contents, Financial
  Summary (cost + phase tables), Project Overview, Scale of Work, Technical Architecture
  (backend/frontend/infra stack tables), Architecture Patterns, Security Implementation, Core
  Features, "The Invisible Excellence" (testing/quality/design-system), Comparison with
  Traditional, Value Delivered (risk + OPEX + optional revenue), and a Documentation Inventory.
- **Bundled zero-dependency `.docx` generator** (`assets/build_docx.py`): turns a JSON data
  file into a styled Word document using **only the Python standard library** (`zipfile` +
  OOXML templating) — no `python-docx`, no `pandoc`, no Word install required. Handles the
  cover/title block, coloured table headers, zebra rows, an emphasised savings/total row, and
  a live Word table-of-contents field. Fallbacks: pandoc (Markdown→docx), then a Word-openable
  HTML as last resort.
- **Strictly read-only**: reads git + repo files, writes one `.docx` (plus a sidecar JSON it
  can clean up) to Downloads — never edits the repo, never commits.
- Stack, build/test commands, module/model/endpoint counts, and test conventions detected from
  the target repo at run time — assumes no stack.
