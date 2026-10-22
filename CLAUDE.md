Mandatory rules, owned and refreshed by orion (never edit the copy): @.claude/orion/BASE_CLAUDE.md

# CLAUDE.md — Maestro

Project-specific facts the mandatory rules rely on, plus Maestro's own coding guidelines (formerly `AGENTS.md`).
A rule written here must not contradict the mandatory rules.

## Build and test commands

| Purpose | Command |
|---|---|
| Build | `npm run build` (TypeScript compile + Vite build) |
| **The full suite** | `npm test` (Vitest) and `cargo test --workspace` (Rust; needs `cargo build --release -p maestro-mcp-server` once first) |
| One file | `npx vitest run src/components/path/Component.test.tsx` |
| One test | `npx vitest run -t "test name pattern"` |
| Typecheck / static analysis | `npx tsc --noEmit` and `cargo clippy` |
| Lint | `npm run lint` (Biome) and `cargo fmt --check` run inside `src-tauri` |
| Dev server (if the review surface needs one) | `npm run tauri dev` (desktop app; `npm run dev` for the web front end alone) |

Other useful commands: `npm run test:watch`, `npx vitest run --changed`, `npx vitest run --reporter=verbose`,
`cargo build --release -p maestro-mcp-server` (build the MCP server), `npm run tauri build` (production app).

## Stack and layout

- Stack: **TypeScript / React 18 on Vite** with **Rust 1.89** for the Tauri backend (pinned in `src-tauri/Cargo.toml`,
  `rust-version`); Node 20+ (CI uses Node 20); tests are **Vitest + React Testing Library + happy-dom** on the front
  end and `#[cfg(test)]` modules in Rust. CI runs on GitHub Actions (`.github/workflows/pr-checks.yml`,
  `ubuntu-latest` for the front end, `ubuntu-22.04` for Rust; the Rust job only runs when Rust-side files changed).
- Layout: application code in `src/` (React front end), `src-tauri/src/` (Tauri backend) and `maestro-mcp-server/`;
  tests in `__tests__/` folders or `*.test.tsx` files beside the code, Rust tests embedded in their source files.
  Skip-count baseline: 0.

```
src/                           # React/TypeScript frontend
├── components/               # UI components
│   ├── Component.tsx
│   └── __tests__/Component.test.tsx
├── hooks/                    # Custom React hooks
├── lib/                      # Utility libraries
├── stores/                   # Zustand state stores
└── types/                    # TypeScript definitions

src-tauri/                    # Tauri Rust backend
└── src/
    ├── commands/            # Tauri command handlers (IPC)
    └── core/                # Core business logic
```

## Worktrees

- Worktree root (outside the project): `C:\git\maestro-wt`. No port rule: the dev server is pinned to port 1420 in
  `vite.config.ts` and `src-tauri/tauri.conf.json`, so only one dev instance runs at a time.
- A fresh worktree needs `npm install` and `cargo build --release -p maestro-mcp-server` before `cargo test` or
  `cargo build` works.

## Boundaries

- Deploys to: GitHub Releases on the fork `nachogl1/maestro`, from `main` (`.github/workflows/release.yml` builds a
  signed installer per push to `main`; the app self-updates from those releases).
- External read-only repositories: the upstream `its-maestro-baby/maestro` (work-item key format: GitHub issue
  numbers). Never open a pull request or push there; every pull request targets `nachogl1/maestro`.
- Sensitive data classes that never enter the repository: Claude session transcripts and app data, API keys, tokens
  and the updater signing key, Granola meeting content, Work Journal entries, and anything carrying a person's name
  or email.
- Boundaries an agent must not move: Maestro edits the user's real Claude Code configuration files when it manages
  MCP servers; never widen what it writes there without a ticket.
- Working language for code, comments, commits, issues and docs: English.

## Pending until PRD v1

| # | File and section | Question | Decided by |
|---|---|---|---|
| P1 | `docs/PRDs/PRD.md` | No PRD exists yet; the product is defined by the shipped app and its GitHub issues. Should one be written with `/wayfinder`? | the maintainer |

## Code Style Guidelines

**VERY IMPORTANT:** Only apply styling and formatting to lines of code that are new or changed.
Never apply styling and formatting to existing code.

### TypeScript/React
- **Formatting**: 100 char line width, 2-space indent
- **Imports**: Group by 1) React/libraries 2) Tauri APIs 3) Local components 4) Relative paths
- **Types**: Use explicit types for function parameters and return types
- **Components**: PascalCase, one component per file, use functional components with hooks
- **Variables/Functions**: camelCase
- **Constants**: UPPER_SNAKE_CASE
- **Interfaces**: Prefix with component name (e.g., `ButtonProps`)

### Rust
- **Naming**: snake_case for functions/variables, PascalCase for types/structs
- **Error handling**: Use `thiserror` for custom errors, `?` operator for propagation
- **Async**: Mark Tauri commands with `#[tauri::command]` and use `async fn`
- **Comments**: Document public APIs with `///`, use `//` for internal notes
- **Organization**: One module per file, export in `mod.rs`
- **Serialization**: Use `serde` with `#[derive(Serialize, Deserialize)]`

### Testing
- **Frontend**: Vitest + React Testing Library + happy-dom
- **Test naming**: Descriptive, e.g., "renders button with correct text"
- **Mocking**: Use `vi.fn()` and `vi.mock()` for Tauri APIs
- **Backend**: Tests embedded in source files with `#[cfg(test)]`
- **Coverage**: Tests in `__tests__/` folders or `*.test.tsx` files

## Naming Conventions

- **React components**: `MyComponent.tsx` with `export function MyComponent()`
- **Hooks**: `useHookName.ts` with `export function useHookName()`
- **Stores**: `useStoreName.ts` with `interface StoreNameState`
- **Rust modules**: `snake_case.rs` with `pub fn command_name()`
- **Tests**: `ComponentName.test.tsx` alongside source or in `__tests__/`

## Error Handling

### TypeScript
```typescript
try {
  const result = await invoke("command", { arg });
} catch (error) {
  console.error("Contextual message:", error);
  setError(error instanceof Error ? error.message : "Unknown error");
}
```

### Rust
```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum MyError {
    #[error("Context: {0}")]
    Io(#[from] std::io::Error),
}

#[tauri::command]
pub async fn command() -> Result<T, String> {
  risky_op().await.map_err(|e| e.to_string())
}
```

## Common Patterns

### Tauri Command Invocation
```typescript
import { invoke } from "@tauri-apps/api/core";
const result = await invoke<ReturnType>("command_name", { arg: value });
```

### Zustand Store
```typescript
import { create } from "zustand";

interface StoreState {
  value: string;
  setValue: (v: string) => void;
}

export const useStore = create<StoreState>((set) => ({
  value: "",
  setValue: (v) => set({ value: v }),
}));
```

## Pre-commit Checklist

1. Run tests: `npm run test`
2. Check formatting: `npx @biomejs/biome check .`
3. Fix issues: `npx @biomejs/biome check --write .`
4. For Rust changes: `cargo clippy && cargo fmt` (format only the files you changed; a bare `cargo fmt` on
   `src-tauri/src/lib.rs` reformats its submodules)

## CI/Build Notes

- Frontend builds to `dist/` directory
- MCP server binary bundled at build time
- Tauri bundles frontend + Rust backend into native apps
- Node 20+ required (matches CI), Rust 1.89+ required

## Development Workflow
Use this workflow when implementing a task or story, refactoring, or fixing a bug.

1. Run all tests to verify nothing is currently broken. A pre-existing failure is yours to fix or to surface
   explicitly before going on (see the mandatory rules), never to ignore.
2. Map the components, Zustand stores, and Rust commands involved before editing — use Grep/Read to find the touched
   files first.
3. Implement the changes needed. Do not apply changes (formatting, style, refactoring) to any other part of the code.
4. Run tests related to the changes.
5. Record the change in the changelog (see "Changelog" below).
6. Briefly summarize the changes made and print them.
7. Describe and suggest next steps.

## Changelog

Every pull request adds its own one-line file under `docs/changelog/` as the mandatory rules describe
(`docs/changelog/YYYY-MM-DD-branch-name.md`, one line per pull request). Settings → Changelog in the app reads that
folder at build time, grouped by day and newest first, so that file is the only place a change is recorded.

- Write the line for a user: one short plain sentence saying what they can now see or do, with no
  implementation detail — that belongs in the PR.
- A pull request with no user-visible change (refactor, tests, CI) still gets its line, kept to a few words.
