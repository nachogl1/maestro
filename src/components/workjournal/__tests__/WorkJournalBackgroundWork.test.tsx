import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalBackupTimer } from "@/hooks/useWorkJournalBackupTimer";
import { useWorkJournalCandidateTimer } from "@/hooks/useWorkJournalCandidateTimer";
import { useWorkJournalDayPages } from "@/hooks/useWorkJournalDayPages";
import { closeWorkJournalWindow } from "@/lib/workJournalWindow";
import { useWorkJournalCandidatesStore } from "@/stores/useWorkJournalCandidatesStore";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { WorkJournalBackgroundWork } from "../WorkJournalBackgroundWork";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  })),
}));
vi.mock("@/hooks/useWorkJournalBackupTimer", () => ({ useWorkJournalBackupTimer: vi.fn() }));
vi.mock("@/hooks/useWorkJournalCandidateTimer", () => ({ useWorkJournalCandidateTimer: vi.fn() }));
vi.mock("@/hooks/useWorkJournalDayPages", () => ({ useWorkJournalDayPages: vi.fn() }));
vi.mock("@/lib/workJournalWindow", () => ({ closeWorkJournalWindow: vi.fn(async () => {}) }));

const initListeners = vi.fn(async () => () => {});

describe("WorkJournalBackgroundWork", () => {
  beforeEach(() => {
    vi.mocked(useWorkJournalBackupTimer).mockClear();
    vi.mocked(useWorkJournalCandidateTimer).mockClear();
    vi.mocked(useWorkJournalDayPages).mockClear();
    initListeners.mockClear();
    vi.mocked(closeWorkJournalWindow).mockClear();
    useWorkJournalCandidatesStore.setState({ initListeners });
  });

  it("runs no journal timers or listeners while the journal is off", () => {
    useWorkJournalSettingsStore.setState({ enabled: false });
    render(<WorkJournalBackgroundWork tabs={[]} />);
    expect(useWorkJournalDayPages).not.toHaveBeenCalled();
    expect(useWorkJournalBackupTimer).not.toHaveBeenCalled();
    expect(useWorkJournalCandidateTimer).not.toHaveBeenCalled();
    expect(initListeners).not.toHaveBeenCalled();
  });

  it("runs no journal timers while the first-run question is unanswered", () => {
    useWorkJournalSettingsStore.setState({ enabled: null });
    render(<WorkJournalBackgroundWork tabs={[]} />);
    expect(useWorkJournalCandidateTimer).not.toHaveBeenCalled();
    expect(initListeners).not.toHaveBeenCalled();
  });

  it("runs the day pages, backup and candidate timers and badge listeners when on", () => {
    useWorkJournalSettingsStore.setState({ enabled: true });
    render(<WorkJournalBackgroundWork tabs={[]} />);
    expect(useWorkJournalDayPages).toHaveBeenCalled();
    expect(useWorkJournalBackupTimer).toHaveBeenCalled();
    expect(useWorkJournalCandidateTimer).toHaveBeenCalledWith([]);
    expect(initListeners).toHaveBeenCalledTimes(1);
  });

  it("closes the pop-out journal window when the user turns the journal off", () => {
    useWorkJournalSettingsStore.setState({ enabled: true });
    render(<WorkJournalBackgroundWork tabs={[]} />);
    expect(closeWorkJournalWindow).not.toHaveBeenCalled();
    act(() => {
      useWorkJournalSettingsStore.setState({ enabled: false });
    });
    expect(closeWorkJournalWindow).toHaveBeenCalledTimes(1);
  });

  it("does not touch windows on start while the journal is off", () => {
    useWorkJournalSettingsStore.setState({ enabled: false });
    render(<WorkJournalBackgroundWork tabs={[]} />);
    expect(closeWorkJournalWindow).not.toHaveBeenCalled();
  });
});
