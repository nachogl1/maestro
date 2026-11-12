import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { forwardErrorsToLog } from "@/lib/frontendLog";

describe("forwardErrorsToLog — front-end errors reach the log file", () => {
  afterEach(() => invoke.mockClear());

  it("forwards console errors, uncaught errors and rejected promises, and still prints them", () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = forwardErrorsToLog();

    console.error("Failed to open project window:", new Error("label taken"));
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new Error("boom") }));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("never resolved");
    window.dispatchEvent(rejection);

    const messages = invoke.mock.calls.map(([, args]) => (args as { message: string }).message);
    expect(messages[0]).toContain("Failed to open project window: Error: label taken");
    expect(messages[1]).toContain("Uncaught: Error: boom");
    expect(messages[2]).toContain("Unhandled rejection: Error: never resolved");
    expect(invoke.mock.calls.every(([cmd]) => cmd === "log_frontend_message")).toBe(true);
    expect(printed).toHaveBeenCalled();

    stop();
    printed.mockRestore();
  });

  it("never loops when logging itself fails", async () => {
    invoke.mockRejectedValueOnce(new Error("ipc down"));
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = forwardErrorsToLog();

    console.error("first");
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledTimes(1);
    stop();
    printed.mockRestore();
  });
});
