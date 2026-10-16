import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { pathsForTerminalInput } from "../terminal";

describe("pathsForTerminalInput", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("quotes for the shell the backend reports (cmd.exe on Windows)", async () => {
    invokeMock.mockResolvedValue("cmd");
    await expect(pathsForTerminalInput(["C:\\My Docs\\a.txt"])).resolves.toBe(
      '"C:\\My Docs\\a.txt"',
    );
    expect(invokeMock).toHaveBeenCalledWith("terminal_shell_family");
  });

  it("quotes POSIX-style for a posix shell", async () => {
    invokeMock.mockResolvedValue("posix");
    await expect(pathsForTerminalInput(["/my docs/a.txt"])).resolves.toBe("'/my docs/a.txt'");
  });

  it("falls back to bare paths when the family lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("no backend"));
    await expect(pathsForTerminalInput(["/a/b"])).resolves.toBe("/a/b");
  });
});
