import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkshopStore } from "@/stores/useWorkshopStore";
import {
  useWorkshopTimer,
  WORKSHOP_CATCH_UP_DELAY_MS,
  WORKSHOP_CHECK_EVERY_MS,
} from "../useWorkshopTimer";

const run = vi.fn(async () => {});

describe("useWorkshopTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    run.mockClear();
    useWorkshopStore.setState({ run });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks for a due run shortly after start, never forced", () => {
    renderHook(() => useWorkshopTimer());

    vi.advanceTimersByTime(WORKSHOP_CATCH_UP_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledWith(false);
  });

  it("checks again every hour while the app is open", () => {
    renderHook(() => useWorkshopTimer());

    vi.advanceTimersByTime(WORKSHOP_CATCH_UP_DELAY_MS + 2 * WORKSHOP_CHECK_EVERY_MS);

    expect(run).toHaveBeenCalledTimes(3);
  });

  it("stops checking once unmounted", () => {
    const { unmount } = renderHook(() => useWorkshopTimer());
    unmount();

    vi.advanceTimersByTime(WORKSHOP_CATCH_UP_DELAY_MS + WORKSHOP_CHECK_EVERY_MS);

    expect(run).not.toHaveBeenCalled();
  });
});
