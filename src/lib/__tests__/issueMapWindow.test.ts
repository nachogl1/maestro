import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISSUE_MAP_OPEN_EVENT,
  ISSUE_MAP_WINDOW_LABEL,
  issueMapWindowTitle,
  openIssueMapWindow,
  readIssueMapTarget,
} from "../issueMapWindow";

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => {
  const WebviewWindow = vi.fn(function (this: { once: unknown }) {
    this.once = vi.fn();
  }) as unknown as { getByLabel: unknown };
  WebviewWindow.getByLabel = vi.fn();
  return { WebviewWindow };
});

const getByLabel = WebviewWindow.getByLabel as unknown as ReturnType<typeof vi.fn>;

describe("readIssueMapTarget", () => {
  it("reads the repo and search of the map window", () => {
    const query = "?view=issue-map&repo=C%3A%5Cgit%5Cmaestro&search=assignee%3A%40me";
    expect(readIssueMapTarget(query)).toEqual({
      repoPath: "C:\\git\\maestro",
      search: "assignee:@me",
    });
  });

  it("returns null for the main window", () => {
    expect(readIssueMapTarget("")).toBeNull();
    expect(readIssueMapTarget("?view=other")).toBeNull();
  });
});

describe("issueMapWindowTitle", () => {
  it("names the project folder on Windows and Unix paths", () => {
    expect(issueMapWindowTitle("C:\\git\\maestro")).toBe("Maestro: Issue map - maestro");
    expect(issueMapWindowTitle("/repos/a b/")).toBe("Maestro: Issue map - a b");
  });

  it("falls back to a plain title without a repo", () => {
    expect(issueMapWindowTitle("")).toBe("Maestro: Issue map");
  });
});

describe("openIssueMapWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a separate window whose URL carries the repo and search", async () => {
    getByLabel.mockResolvedValue(null);
    await openIssueMapWindow({ repoPath: "/repos/a b", search: "is:open" });

    expect(WebviewWindow).toHaveBeenCalledTimes(1);
    const [label, options] = vi.mocked(WebviewWindow).mock.calls[0];
    expect(label).toBe(ISSUE_MAP_WINDOW_LABEL);
    const query = (options?.url ?? "").split("?")[1];
    expect(readIssueMapTarget(`?${query}`)).toEqual({ repoPath: "/repos/a b", search: "is:open" });
    expect(options?.title).toBe("Maestro: Issue map - a b");
  });

  it("points an already open window at the repo and brings it forward", async () => {
    const existing = {
      unminimize: vi.fn(() => Promise.resolve()),
      setFocus: vi.fn(() => Promise.resolve()),
    };
    getByLabel.mockResolvedValue(existing);
    const target = { repoPath: "/repos/b", search: "" };
    await openIssueMapWindow(target);

    expect(WebviewWindow).not.toHaveBeenCalled();
    expect(emitTo).toHaveBeenCalledWith(ISSUE_MAP_WINDOW_LABEL, ISSUE_MAP_OPEN_EVENT, target);
    expect(existing.unminimize).toHaveBeenCalled();
    expect(existing.setFocus).toHaveBeenCalled();
  });
});
