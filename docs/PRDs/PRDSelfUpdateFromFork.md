# PRD: Self-update from the fork's releases

Date: 2026-10-15

## Problem

Every improvement merged into this fork had to be installed by hand: build
locally, uninstall Maestro, run the new MSI. The app already ships an updater
(startup check, banner, one-click install), but it points at the upstream
project's releases and trusts only the upstream signing key, so it never sees
the fork's work.

## Goals

- Every push to `main` publishes a signed Windows installer as a GitHub
  release on the fork, with the `latest.json` file the updater reads.
- The installed app offers the new build by itself and installs it on one
  click, closing and relaunching Maestro on its own.
- Local `npm run tauri build` keeps working without the signing key.

## Non-goals

- macOS and Linux builds (nobody on the fork uses them yet).
- Committing version bumps back to `main`.
- Replacing the MSI with the NSIS installer.

## Design

- **Updater endpoint and key.** `tauri.conf.json` points at
  `nachogl1/maestro/releases/latest/download/latest.json` and carries the
  fork's own minisign public key. The private key lives in the repo secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and
  in the maintainer's `~/.tauri/maestro-fork.key` with its password in
  `~/.tauri/maestro-fork.key.password`. Losing them means installed apps stop
  accepting updates until they are reinstalled by hand.
- **Release workflow** (`.github/workflows/release.yml`). Runs on push to
  `main` (docs-only pushes skipped) and on manual dispatch, one run at a time.
  The job only runs for `main`, so a manual run from another branch cannot
  become the "latest" release. It builds the MCP server sidecar, then uses
  `tauri-apps/tauri-action` to
  build the MSI, sign it, create the release `vX.Y.Z` and upload the installer,
  its signature and `latest.json`.
- **Version scheme.** `MAJOR.MINOR` come from `tauri.conf.json`; `PATCH` is
  the workflow run number. The version is written into the working copy only,
  so the repo stays at its base version and nothing is committed by CI. The
  repo version moves from 0.2.5 to 0.3.0 with this change so that every CI
  build (0.3.1, 0.3.2, ...) is newer than any installed 0.2.x build. A local
  build is 0.3.0, so it is offered the latest CI release, which is correct.
- **Signing only in CI.** `bundle.createUpdaterArtifacts` is switched on by
  the workflow, not in the repo, because with it on the build fails when the
  private key is absent. Local builds therefore produce an unsigned MSI as
  before.
- **Installer type.** Only the MSI is built, so `latest.json` can only point
  at an MSI and the installed MSI copy upgrades in place (Tauri's WiX template
  allows same-version, newer and, by default, older versions to install over
  the current one). The updater runs
  `msiexec /passive` with auto-relaunch; because the app is installed
  per-machine, Windows shows one UAC prompt.

## Rollout

1. Merge; the first release build runs on that merge.
2. Install that first release once by hand: the currently installed app still
   trusts the upstream key and will reject fork-signed updates.
3. From then on the startup banner offers each new release.

## Risks

- The updater exits the app right after starting `msiexec`, so the cleanup
  that follows the install call never runs on Windows. Fixed in #324: the
  updater's before-exit hook now kills every terminal (and the Claude CLIs and
  bundled MCP server exe in their process trees) before `msiexec` starts, so
  no file is still open and Windows does not ask for a reboot.
- Renaming the workflow file resets the run number and versions would go
  backwards; bump `MINOR` in `tauri.conf.json` if that is ever needed.
- The `latest` release on GitHub is the newest non-draft, non-prerelease
  release, so manual releases on the fork must follow the same rules.
