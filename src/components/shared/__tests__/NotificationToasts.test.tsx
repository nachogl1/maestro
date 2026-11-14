import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The persisted zustand stores (watchdog, workspace) hydrate through the
// Tauri store plugin at import time; happy-dom has no Tauri backend, so
// stub it out — same pattern as useGitHubWatchdogStore.test.ts.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

import type { WatchdogToast } from "@/stores/useGitHubWatchdogStore";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { NotificationToasts } from "../NotificationToasts";

function watchdogToast(overrides: Partial<WatchdogToast> = {}): WatchdogToast {
  return {
    id: "watchdog-1",
    projectName: "maestro",
    repoPath: "C:/git/maestro",
    kind: "pr",
    number: 42,
    title: "Fix login bug",
    url: "https://github.com/o/r/pull/42",
    ...overrides,
  };
}

describe("NotificationToasts", () => {
  it("composes the PR-review kicker as '<Project> — Review requested', title unchanged", () => {
    useGitHubWatchdogStore.setState({ toasts: [watchdogToast()] });

    render(<NotificationToasts />);

    expect(screen.getByText("maestro — Review requested")).toBeInTheDocument();
    expect(screen.getByText("#42 Fix login bug")).toBeInTheDocument();
    // The project name now lives in the kicker; it must not also appear as
    // a separate detail line (there is no exact-match "maestro" text node).
    expect(screen.queryByText("maestro", { exact: true })).toBeNull();
  });

  it("composes the issue-assigned kicker as '<Project> — Issue assigned'", () => {
    useGitHubWatchdogStore.setState({
      toasts: [
        watchdogToast({ id: "watchdog-2", kind: "issue", number: 7, title: "Crash on save" }),
      ],
    });

    render(<NotificationToasts />);

    expect(screen.getByText("maestro — Issue assigned")).toBeInTheDocument();
    expect(screen.getByText("#7 Crash on save")).toBeInTheDocument();
  });
});
