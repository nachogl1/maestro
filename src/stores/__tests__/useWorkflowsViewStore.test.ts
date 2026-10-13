import { beforeEach, describe, expect, it } from "vitest";
import { useWorkflowsViewStore } from "../useWorkflowsViewStore";

describe("useWorkflowsViewStore", () => {
  beforeEach(() => {
    useWorkflowsViewStore.setState({ isOpen: false });
  });

  it("starts closed", () => {
    expect(useWorkflowsViewStore.getInitialState().isOpen).toBe(false);
  });

  it("open sets isOpen to true", () => {
    useWorkflowsViewStore.getState().open();
    expect(useWorkflowsViewStore.getState().isOpen).toBe(true);
  });

  it("close sets isOpen back to false", () => {
    useWorkflowsViewStore.getState().open();
    useWorkflowsViewStore.getState().close();
    expect(useWorkflowsViewStore.getState().isOpen).toBe(false);
  });

  it("open is idempotent", () => {
    useWorkflowsViewStore.getState().open();
    useWorkflowsViewStore.getState().open();
    expect(useWorkflowsViewStore.getState().isOpen).toBe(true);
  });
});
