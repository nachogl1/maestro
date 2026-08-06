import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { SamuraiBadge } from "../SamuraiBadge";
import {
  useSessionStore,
  type SamuraiSessionInfo,
  type SessionConfig,
} from "@/stores/useSessionStore";

function session(id: number, projectPath = "C:/proj", contextPercent?: number): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status: "Working",
    worktree_path: null,
    project_path: projectPath,
    contextPercent,
  };
}

function supervised(overrides: Partial<SamuraiSessionInfo> = {}): SamuraiSessionInfo {
  return {
    project: "C:/proj",
    epic: "#36",
    generation: 2,
    state: "WORKING",
    ...overrides,
  };
}

describe("SamuraiBadge (issue #46)", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], samuraiBySessionId: {} });
  });

  it("renders generation, human state and context % for a supervised session", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:/proj", 43.2)],
      samuraiBySessionId: { 1: supervised() },
    });
    render(<SamuraiBadge sessionId={1} />);

    expect(screen.getByText("gen-2 · working · 43%")).toBeInTheDocument();
  });

  it("omits the context % until usage data has arrived", () => {
    useSessionStore.setState({
      sessions: [session(1)],
      samuraiBySessionId: { 1: supervised({ generation: 3, state: "PARKED" }) },
    });
    render(<SamuraiBadge sessionId={1} />);

    expect(screen.getByText("gen-3 · parked")).toBeInTheDocument();
  });

  it("shows human labels, not state-machine names (PRD §9)", () => {
    useSessionStore.setState({
      sessions: [session(1)],
      samuraiBySessionId: { 1: supervised({ state: "HANDOFF_REQUESTED" }) },
    });
    render(<SamuraiBadge sessionId={1} />);

    expect(screen.getByText(/handing off/)).toBeInTheDocument();
    expect(screen.queryByText(/HANDOFF_REQUESTED/)).toBeNull();
  });

  it("renders nothing for a non-supervised session", () => {
    useSessionStore.setState({ sessions: [session(1, "C:/proj", 43.2)] });
    const { container } = render(<SamuraiBadge sessionId={1} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the supervised project does not match the session's", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:/other")],
      samuraiBySessionId: { 1: supervised({ project: "C:/proj" }) },
    });
    const { container } = render(<SamuraiBadge sessionId={1} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("updates live when a supervisor event advances the state", () => {
    useSessionStore.setState({
      sessions: [session(1)],
      samuraiBySessionId: { 1: supervised({ state: "WORKING" }) },
    });
    render(<SamuraiBadge sessionId={1} />);
    expect(screen.getByText(/working/)).toBeInTheDocument();

    act(() => {
      useSessionStore.setState({
        samuraiBySessionId: { 1: supervised({ state: "DEAD" }) },
      });
    });
    expect(screen.getByText(/dead/)).toBeInTheDocument();
  });
});
