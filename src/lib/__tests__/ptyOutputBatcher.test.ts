import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPtyOutputBatcher } from "../ptyOutputBatcher";

describe("createPtyOutputBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes buffered chunks once, joined, on the scheduled flush", () => {
    const write = vi.fn();
    const batcher = createPtyOutputBatcher(
      () => ({ write }),
      () => false,
    );

    batcher.push("a");
    batcher.push("b");
    expect(write).not.toHaveBeenCalled();
    expect(batcher.hasPending()).toBe(true);

    vi.advanceTimersByTime(50);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("ab");
    expect(batcher.hasPending()).toBe(false);
  });

  it("flushes immediately when the buffer reaches 100 chunks", () => {
    const write = vi.fn();
    const batcher = createPtyOutputBatcher(
      () => ({ write }),
      () => false,
    );

    for (let i = 0; i < 100; i++) batcher.push("x");
    expect(write).toHaveBeenCalledWith("x".repeat(100));
  });

  it("drops buffered output instead of writing once disposed", () => {
    const write = vi.fn();
    let disposed = false;
    const batcher = createPtyOutputBatcher(
      () => ({ write }),
      () => disposed,
    );

    batcher.push("late");
    disposed = true;
    batcher.flush();
    expect(write).not.toHaveBeenCalled();
    expect(batcher.hasPending()).toBe(false);
  });

  it("drain writes what is left and cancelled flushes never fire", () => {
    const write = vi.fn();
    const batcher = createPtyOutputBatcher(
      () => ({ write }),
      () => true,
    );

    batcher.push("tail");
    batcher.cancelPendingFlush();
    batcher.drain();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("tail");
  });
});
