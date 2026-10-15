import { invoke } from "@tauri-apps/api/core";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useWorkJournalBackupTimer,
  WORK_JOURNAL_BACKUP_CHECK_MS,
} from "@/hooks/useWorkJournalBackupTimer";

const invokeMock = vi.mocked(invoke);

function ifDueCalls(): number {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === "work_journal_backup_if_due").length;
}

describe("useWorkJournalBackupTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks once on mount, again every hour, and stops on unmount", () => {
    const { unmount } = renderHook(() => useWorkJournalBackupTimer());
    expect(ifDueCalls()).toBe(1);

    vi.advanceTimersByTime(WORK_JOURNAL_BACKUP_CHECK_MS - 1);
    expect(ifDueCalls()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(ifDueCalls()).toBe(2);
    vi.advanceTimersByTime(WORK_JOURNAL_BACKUP_CHECK_MS);
    expect(ifDueCalls()).toBe(3);

    unmount();
    vi.advanceTimersByTime(WORK_JOURNAL_BACKUP_CHECK_MS * 3);
    expect(ifDueCalls()).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
