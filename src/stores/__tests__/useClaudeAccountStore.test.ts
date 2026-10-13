import { beforeEach, describe, expect, it, vi } from "vitest";

const getClaudeAccount = vi.fn();
vi.mock("@/lib/usageParser", () => ({
  getClaudeAccount: () => getClaudeAccount(),
}));

import { useClaudeAccountStore } from "../useClaudeAccountStore";

describe("useClaudeAccountStore", () => {
  beforeEach(() => {
    getClaudeAccount.mockReset();
    useClaudeAccountStore.setState({ account: null, loaded: false });
  });

  it("fetch stores the account and marks the store loaded", async () => {
    const account = { loggedIn: true, email: "a@b.c", subscriptionType: "max" };
    getClaudeAccount.mockResolvedValue(account);

    await useClaudeAccountStore.getState().fetch();

    expect(useClaudeAccountStore.getState().account).toEqual(account);
    expect(useClaudeAccountStore.getState().loaded).toBe(true);
  });

  it("fetch is a no-op once loaded", async () => {
    getClaudeAccount.mockResolvedValue({ loggedIn: true, email: null, subscriptionType: null });

    await useClaudeAccountStore.getState().fetch();
    await useClaudeAccountStore.getState().fetch();

    expect(getClaudeAccount).toHaveBeenCalledTimes(1);
  });

  it("fetch failure keeps account null but marks loaded", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getClaudeAccount.mockRejectedValue(new Error("boom"));

    await useClaudeAccountStore.getState().fetch();

    expect(useClaudeAccountStore.getState().account).toBeNull();
    expect(useClaudeAccountStore.getState().loaded).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
