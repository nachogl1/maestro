import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A Channel stand-in: the test plays the backend by calling `onmessage`.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (data: unknown) => void = () => {};
  },
}));

import { attachPtyOutput } from "@/lib/terminal";

const invokeMock = vi.mocked(invoke);

type FakeChannel = { onmessage: (data: string) => void };

describe("attachPtyOutput", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("attaches with a channel and forwards everything it receives", async () => {
    invokeMock.mockResolvedValueOnce(7);
    const received: string[] = [];
    await attachPtyOutput(3, (data) => received.push(data));

    expect(invokeMock).toHaveBeenCalledWith("attach_session_output", {
      sessionId: 3,
      onOutput: expect.anything(),
    });
    const channel = (invokeMock.mock.calls[0][1] as { onOutput: FakeChannel }).onOutput;
    channel.onmessage("scrollback");
    channel.onmessage("live");
    expect(received).toEqual(["scrollback", "live"]);
  });

  it("detaches with the subscription id and stops forwarding", async () => {
    invokeMock.mockResolvedValueOnce(7).mockResolvedValueOnce(undefined);
    const received: string[] = [];
    const detach = await attachPtyOutput(3, (data) => received.push(data));
    const channel = (invokeMock.mock.calls[0][1] as { onOutput: FakeChannel }).onOutput;

    detach();
    channel.onmessage("late");

    expect(invokeMock).toHaveBeenLastCalledWith("detach_session_output", {
      sessionId: 3,
      subscriberId: 7,
    });
    expect(received).toEqual([]);
  });
});
