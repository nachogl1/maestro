import { beforeEach, describe, expect, it, vi } from "vitest";

const checkFullDiskAccess = vi.fn();
const pathRequiresFDA = vi.fn();
vi.mock("@/lib/permissions", () => ({
  checkFullDiskAccess: () => checkFullDiskAccess(),
  pathRequiresFDA: (path: string) => pathRequiresFDA(path),
}));

import { useFDAStore } from "../useFDAStore";

const DISMISSED_KEY = "maestro:permissions:fda-dismissed";

describe("useFDAStore", () => {
  beforeEach(() => {
    checkFullDiskAccess.mockReset();
    pathRequiresFDA.mockReset();
    localStorage.clear();
    useFDAStore.setState({ showDialog: false, pendingPath: null, pendingCallback: null });
  });

  it("requireAccess calls onGranted immediately when the path needs no FDA", async () => {
    pathRequiresFDA.mockReturnValue(false);
    const onGranted = vi.fn();

    await useFDAStore.getState().requireAccess("/tmp/x", onGranted);

    expect(onGranted).toHaveBeenCalledTimes(1);
    expect(checkFullDiskAccess).not.toHaveBeenCalled();
    expect(useFDAStore.getState().showDialog).toBe(false);
  });

  it("requireAccess calls onGranted and clears a stale dismissal when FDA is granted", async () => {
    pathRequiresFDA.mockReturnValue(true);
    checkFullDiskAccess.mockResolvedValue(true);
    localStorage.setItem(DISMISSED_KEY, "true");
    const onGranted = vi.fn();

    await useFDAStore.getState().requireAccess("/Users/me/Desktop", onGranted);

    expect(onGranted).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
    expect(useFDAStore.getState().showDialog).toBe(false);
  });

  it("requireAccess shows the dialog and stores the callback when FDA is missing", async () => {
    pathRequiresFDA.mockReturnValue(true);
    checkFullDiskAccess.mockResolvedValue(false);
    const onGranted = vi.fn();

    await useFDAStore.getState().requireAccess("/Users/me/Desktop", onGranted);

    const state = useFDAStore.getState();
    expect(onGranted).not.toHaveBeenCalled();
    expect(state.showDialog).toBe(true);
    expect(state.pendingPath).toBe("/Users/me/Desktop");
    expect(state.pendingCallback).toBe(onGranted);
  });

  it("requireAccess proceeds without a dialog when the user dismissed permanently", async () => {
    pathRequiresFDA.mockReturnValue(true);
    checkFullDiskAccess.mockResolvedValue(false);
    localStorage.setItem(DISMISSED_KEY, "true");
    const onGranted = vi.fn();

    await useFDAStore.getState().requireAccess("/Users/me/Desktop", onGranted);

    expect(onGranted).toHaveBeenCalledTimes(1);
    expect(useFDAStore.getState().showDialog).toBe(false);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("true");
  });

  it("dismiss closes the dialog and drops the pending callback", () => {
    useFDAStore.setState({ showDialog: true, pendingPath: "/p", pendingCallback: vi.fn() });

    useFDAStore.getState().dismiss();

    expect(useFDAStore.getState()).toMatchObject({
      showDialog: false,
      pendingPath: null,
      pendingCallback: null,
    });
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  it("dismissPermanently closes the dialog and remembers the choice", () => {
    useFDAStore.setState({ showDialog: true, pendingPath: "/p", pendingCallback: vi.fn() });

    useFDAStore.getState().dismissPermanently();

    expect(useFDAStore.getState().showDialog).toBe(false);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("true");
  });

  it("retryAfterGrant runs the pending callback and closes the dialog once FDA is granted", async () => {
    const callback = vi.fn();
    useFDAStore.setState({ showDialog: true, pendingPath: "/p", pendingCallback: callback });
    checkFullDiskAccess.mockResolvedValue(true);

    await useFDAStore.getState().retryAfterGrant();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(useFDAStore.getState()).toMatchObject({
      showDialog: false,
      pendingPath: null,
      pendingCallback: null,
    });
  });

  it("retryAfterGrant keeps the dialog open while FDA is still missing", async () => {
    const callback = vi.fn();
    useFDAStore.setState({ showDialog: true, pendingPath: "/p", pendingCallback: callback });
    checkFullDiskAccess.mockResolvedValue(false);

    await useFDAStore.getState().retryAfterGrant();

    expect(callback).not.toHaveBeenCalled();
    expect(useFDAStore.getState().showDialog).toBe(true);
    expect(useFDAStore.getState().pendingCallback).toBe(callback);
  });
});
