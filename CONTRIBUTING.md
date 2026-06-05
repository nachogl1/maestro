# Contributing to Maestro

Thanks for contributing! This file documents the repo-specific workflow. Generic
community policy lives in [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) and
[`SECURITY.md`](SECURITY.md).

## Development setup

1. Fork and clone the repository (`git clone https://github.com/nachogl1/maestro.git`).
2. Install npm dependencies: `npm install`
3. Build the MCP server: `cargo build --release -p maestro-mcp-server`
4. Run in dev mode: `npm run tauri dev`

See the [README](README.md#installation) for platform prerequisites.

## Before you open a PR

```bash
npm run test                 # frontend tests pass (Vitest)
npx @biomejs/biome check .   # lint + format
# Rust changes (run from src-tauri/):
cargo test --workspace
cargo clippy
cargo fmt --check
```

## Branch & commit conventions

- Branch format: `<type>/<short-desc>` — type ∈ {feat, fix, chore, refactor, docs, test}.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:` …).
- Never push directly to `main`. Open a PR; a maintainer merges.

## Merge rules

- CI (`ci.yml` + `pr-checks.yml`) must be green before merge.
- Squash-merge to `main` to keep history linear.

## Follow-ups

Out-of-scope findings during a PR → open a GitHub Issue and link the `#N` in the
PR's "Out-of-scope / follow-ups" section. A deferred item without a `#N` is a
dropped commitment.

## Agent contributors

Issues carry an **agent-ready** / **needs-human-decision** signal. An autonomous
agent should only take an issue end-to-end when it is marked agent-ready; anything
needing a human decision must be resolved before work starts.
