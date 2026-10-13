import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  deletePlugin: vi.fn(),
  deleteSkill: vi.fn(),
  getProjectPlugins: vi.fn(),
  refreshProjectPlugins: vi.fn(),
}));

// The lib wraps Tauri invoke; mock it before importing the store module.
vi.mock("@/lib/plugins", () => api);

import type { PluginConfig, SkillConfig } from "@/lib/plugins";
import { usePluginStore } from "../usePluginStore";

const P = "/proj";

function result(skillIds: string[], pluginIds: string[]) {
  return {
    skills: skillIds.map((id) => ({ id }) as SkillConfig),
    plugins: pluginIds.map((id) => ({ id }) as PluginConfig),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const INITIAL = usePluginStore.getState();

describe("usePluginStore", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    usePluginStore.setState(INITIAL, true);
  });

  it("fetchProjectPlugins stores skills and plugins per project", async () => {
    api.getProjectPlugins.mockResolvedValue(result(["s1"], ["p1"]));

    await usePluginStore.getState().fetchProjectPlugins(P);

    const s = usePluginStore.getState();
    expect(api.getProjectPlugins).toHaveBeenCalledWith(P);
    expect(s.projectSkills[P].map((x) => x.id)).toEqual(["s1"]);
    expect(s.projectPlugins[P].map((x) => x.id)).toEqual(["p1"]);
    expect(s.isLoading[P]).toBe(false);
    expect(s.errors[P]).toBeNull();
  });

  it("fetchProjectPlugins records the error and clears loading on failure", async () => {
    api.getProjectPlugins.mockRejectedValue("parse error");

    await usePluginStore.getState().fetchProjectPlugins(P);

    expect(usePluginStore.getState().errors[P]).toBe("parse error");
    expect(usePluginStore.getState().isLoading[P]).toBe(false);
  });

  it("refreshProjectPlugins replaces cached data and clears a prior error", async () => {
    usePluginStore.setState({
      projectSkills: { [P]: result(["old"], []).skills },
      errors: { [P]: "stale" },
    });
    api.refreshProjectPlugins.mockResolvedValue(result(["new"], ["p"]));

    await usePluginStore.getState().refreshProjectPlugins(P);

    const s = usePluginStore.getState();
    expect(s.projectSkills[P].map((x) => x.id)).toEqual(["new"]);
    expect(s.errors[P]).toBeNull();
  });

  it("deleteSkill marks the skill as deleting, deletes, then refreshes", async () => {
    const gate = deferred();
    api.deleteSkill.mockReturnValue(gate.promise);
    api.refreshProjectPlugins.mockResolvedValue(result([], []));

    const run = usePluginStore.getState().deleteSkill("s1", "/skills/s1/SKILL.md", P);
    expect(usePluginStore.getState().deletingSkillId).toBe("s1");
    gate.resolve();
    await run;

    expect(api.deleteSkill).toHaveBeenCalledWith("/skills/s1/SKILL.md");
    expect(api.refreshProjectPlugins).toHaveBeenCalledWith(P);
    expect(usePluginStore.getState().deletingSkillId).toBeNull();
  });

  it("deleteSkill records the error and clears deletingSkillId on failure", async () => {
    api.deleteSkill.mockRejectedValue("denied");

    await usePluginStore.getState().deleteSkill("s1", "/x", P);

    expect(usePluginStore.getState().errors[P]).toBe("denied");
    expect(usePluginStore.getState().deletingSkillId).toBeNull();
    expect(api.refreshProjectPlugins).not.toHaveBeenCalled();
  });

  it("deletePlugin deletes then refreshes, clearing deletingPluginId", async () => {
    api.deletePlugin.mockResolvedValue(undefined);
    api.refreshProjectPlugins.mockResolvedValue(result([], ["left"]));

    await usePluginStore.getState().deletePlugin("p1", "/plugins/p1", P);

    expect(api.deletePlugin).toHaveBeenCalledWith("/plugins/p1");
    expect(usePluginStore.getState().projectPlugins[P].map((x) => x.id)).toEqual(["left"]);
    expect(usePluginStore.getState().deletingPluginId).toBeNull();
  });

  it("deletePlugin records the error on failure", async () => {
    api.deletePlugin.mockRejectedValue("in use");

    await usePluginStore.getState().deletePlugin("p1", "/x", P);

    expect(usePluginStore.getState().errors[P]).toBe("in use");
    expect(usePluginStore.getState().deletingPluginId).toBeNull();
  });
});
