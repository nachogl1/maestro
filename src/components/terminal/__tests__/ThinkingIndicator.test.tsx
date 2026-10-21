import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import {
  type BackendSessionStatus,
  type SessionConfig,
  useSessionStore,
} from "@/stores/useSessionStore";
import { SessionStatusDot, ThinkingIndicator } from "../ThinkingIndicator";

function session(status: BackendSessionStatus): SessionConfig {
  return {
    id: 1,
    mode: "Claude",
    branch: null,
    status,
    worktree_path: null,
    project_path: "C:/proj",
  };
}

/** The three dot spans inside the indicator. */
function dots(): HTMLElement[] {
  return Array.from(screen.getByRole("status").querySelectorAll("span")) as HTMLElement[];
}

describe("ThinkingIndicator", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
  });

  it("ripples in blue while the agent is working", () => {
    useSessionStore.setState({ sessions: [session("Working")] });
    render(<ThinkingIndicator sessionId={1} />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Model is thinking");
    for (const dot of dots()) {
      expect(dot).toHaveClass("bg-maestro-blue");
      expect(dot).toHaveClass("animate-thinking-dot");
    }
  });

  it("ripples in the accent colour while the agent waits for the user", () => {
    useSessionStore.setState({ sessions: [session("NeedsInput")] });
    render(<ThinkingIndicator sessionId={1} />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Awaiting user input");
    for (const dot of dots()) {
      expect(dot).toHaveClass("bg-maestro-accent");
      // Needs-input used to render static, which read the same as a stale dot.
      expect(dot).toHaveClass("animate-thinking-dot");
    }
  });

  it("stands still when there is nothing to report", () => {
    useSessionStore.setState({ sessions: [session("Idle")] });
    render(<ThinkingIndicator sessionId={1} />);

    for (const dot of dots()) {
      expect(dot).not.toHaveClass("animate-thinking-dot");
      expect(dot).toHaveClass("opacity-60");
    }
  });

  /**
   * Issue #77 cause 6: every state that is not Working/NeedsInput used to be
   * labelled "Idle", so a crashed, finished or still-starting agent read
   * exactly like one with nothing to do.
   */
  it("names every state instead of calling them all idle", () => {
    const cases: Array<[BackendSessionStatus, string]> = [
      ["Starting", "Starting up"],
      ["Idle", "Idle"],
      ["Done", "Finished"],
      ["Error", "Errored"],
      ["Timeout", "Startup timed out"],
    ];
    for (const [status, label] of cases) {
      useSessionStore.setState({ sessions: [session(status)] });
      const { unmount } = render(<ThinkingIndicator sessionId={1} />);
      expect(screen.getByRole("status")).toHaveAttribute("aria-label", label);
      unmount();
    }
  });

  it("still says something when no status has been reported at all", () => {
    useSessionStore.setState({ sessions: [] });
    render(<ThinkingIndicator sessionId={1} />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "No status reported");
  });

  it("never animates a session that has stopped", () => {
    for (const status of ["Done", "Error", "Timeout", "Idle"] as BackendSessionStatus[]) {
      useSessionStore.setState({ sessions: [session(status)] });
      const { unmount } = render(<ThinkingIndicator sessionId={1} />);
      for (const dot of dots()) {
        expect(dot).not.toHaveClass("animate-thinking-dot");
      }
      unmount();
    }
  });

  it("labels the bare status dot as well", () => {
    useSessionStore.setState({ sessions: [session("NeedsInput")] });
    render(<SessionStatusDot sessionId={1} />);

    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "Awaiting user input");
  });

  it("paints the bare status dot green while busy and red whenever the user is up", () => {
    const cases: Array<[BackendSessionStatus, string]> = [
      ["Starting", "bg-maestro-green"],
      ["Working", "bg-maestro-green"],
      ["Idle", "bg-maestro-accent"],
      ["NeedsInput", "bg-maestro-accent"],
      ["Done", "bg-maestro-accent"],
      ["Error", "bg-maestro-accent"],
      ["Timeout", "bg-maestro-accent"],
    ];
    for (const [status, color] of cases) {
      useSessionStore.setState({ sessions: [session(status)] });
      const { unmount } = render(<SessionStatusDot sessionId={1} />);
      expect(screen.getByRole("img")).toHaveClass(color);
      unmount();
    }
  });

  it("staggers the three dots so they ripple rather than blink together", () => {
    useSessionStore.setState({ sessions: [session("Working")] });
    render(<ThinkingIndicator sessionId={1} />);

    expect(dots().map((d) => d.style.animationDelay)).toEqual(["0ms", "180ms", "360ms"]);
  });

  /**
   * Regression guard. The dots were previously given
   * `motion-safe:animate-thinking-dot`, but `animate-thinking-dot` is
   * hand-written in globals.css rather than a Tailwind theme animation, so
   * Tailwind never emitted a `motion-safe:` variant and the animation silently
   * never ran. Reduced motion is handled by the media query instead.
   */
  it("applies the animation class plainly, and globals.css defines it", () => {
    useSessionStore.setState({ sessions: [session("Working")] });
    render(<ThinkingIndicator sessionId={1} />);

    for (const dot of dots()) {
      expect(dot.className).not.toContain("motion-safe");
    }

    const css = readFileSync(resolve(__dirname, "../../../styles/globals.css"), "utf8");
    expect(css).toContain(".animate-thinking-dot {");
    expect(css).toContain("@keyframes thinking-dot");
    // …and reduced motion still switches it off.
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*\.animate-thinking-dot/);
  });
});
