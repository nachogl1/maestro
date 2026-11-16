import { beforeEach, describe, expect, it } from "vitest";
import type { PillProjectData } from "../projectsPillData";
import { forgetRememberedProjects, recallProject, rememberProject } from "../projectsPillMemory";

const DATA: PillProjectData = { labels: [], openIssues: [], truncated: false };

describe("projectsPillMemory", () => {
  beforeEach(() => forgetRememberedProjects());

  it("recalls a tab's last load only while the tab still points at the same folder", () => {
    rememberProject("tab-1", "/work/widgets", { kind: "ready", data: DATA });

    expect(recallProject("tab-1", "/work/widgets")).toEqual({ kind: "ready", data: DATA });
    expect(recallProject("tab-1", "/work/gadgets")).toBeNull();
    expect(recallProject("tab-2", "/work/widgets")).toBeNull();
  });
});
