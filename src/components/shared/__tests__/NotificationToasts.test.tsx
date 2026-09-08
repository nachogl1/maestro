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
import type { HealthToast } from "@/stores/useHealthStore";
import { useHealthStore } from "@/stores/useHealthStore";
import type { SamuraiToast } from "@/stores/useSessionStore";
import { useSessionStore } from "@/stores/useSessionStore";
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

function healthToast(overrides: Partial<HealthToast> = {}): HealthToast {
  return {
    id: "health-1",
    area: "memory",
    target: "maestro",
    reason: "12 stale files",
    ...overrides,
  };
}

function samuraiToast(overrides: Partial<SamuraiToast> = {}): SamuraiToast {
  return {
    id: "samurai-1",
    kind: "fatal",
    project: "C:/git/maestro",
    epic: "#37",
    generation: 2,
    label: "Circuit breaker parked the run",
    ...overrides,
  };
}

describe("NotificationToasts", () => {
  it("composes the PR-review kicker as '<Project> — Review requested', title unchanged", () => {
    useGitHubWatchdogStore.setState({ toasts: [watchdogToast()] });
    useHealthStore.setState({ toasts: [] });

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
    useHealthStore.setState({ toasts: [] });

    render(<NotificationToasts />);

    expect(screen.getByText("maestro — Issue assigned")).toBeInTheDocument();
    expect(screen.getByText("#7 Crash on save")).toBeInTheDocument();
  });

  it("composes the health kicker as 'Health — <Area>', keeping target/reason as title/detail", () => {
    useGitHubWatchdogStore.setState({ toasts: [] });
    useHealthStore.setState({ toasts: [healthToast()] });

    render(<NotificationToasts />);

    expect(screen.getByText("Health — Memory")).toBeInTheDocument();
    expect(screen.getByText("maestro")).toBeInTheDocument();
    expect(screen.getByText("12 stale files")).toBeInTheDocument();
  });

  it("keeps the run-fatal samurai kicker as '<Project> — Samurai run needs you'", () => {
    useGitHubWatchdogStore.setState({ toasts: [] });
    useHealthStore.setState({ toasts: [] });
    useSessionStore.setState({ samuraiToasts: [samuraiToast()] });

    render(<NotificationToasts />);

    expect(screen.getByText("maestro — Samurai run needs you")).toBeInTheDocument();
    expect(screen.getByText("Circuit breaker parked the run")).toBeInTheDocument();
    expect(screen.getByText("#37 · gen-2")).toBeInTheDocument();
  });

  it("reads an allowance park as a planned pause, with the dated resume time", () => {
    useGitHubWatchdogStore.setState({ toasts: [] });
    useHealthStore.setState({ toasts: [] });
    useSessionStore.setState({
      samuraiToasts: [
        samuraiToast({
          kind: "park",
          generation: 0,
          label: "resumes 13/08/2026, 10:05 · in 6d 23h 5m",
        }),
      ],
    });

    render(<NotificationToasts />);

    expect(screen.getByText("maestro — Samurai parked")).toBeInTheDocument();
    expect(screen.getByText("#37 parked on token allowance")).toBeInTheDocument();
    // The resume reading is dated, never a bare time-of-day.
    expect(screen.getByText("resumes 13/08/2026, 10:05 · in 6d 23h 5m")).toBeInTheDocument();
    // A park is not a death: it must not borrow the fatal wording.
    expect(screen.queryByText(/needs you/)).not.toBeInTheDocument();
  });
});
