import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

/**
 * MarkdownBody defers its renderer behind `lazy()` — warm it once here so
 * the viewer test does not pay the dynamic-import cost inside a
 * `findByText` (the `SecondBrainSection.test.tsx` precedent).
 */
beforeAll(async () => {
  await Promise.all([
    import("react-markdown"),
    import("rehype-raw"),
    import("remark-gfm"),
    import("remark-gemoji"),
  ]);
});

import type { SamuraiHarvestReport } from "@/lib/samurai";
import { HarvestReportsSection } from "../HarvestReportsSection";

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);

function report(overrides: Partial<SamuraiHarvestReport> = {}): SamuraiHarvestReport {
  return {
    path: "C:\\data\\harvest\\maestro-harvest-insights-2026-08-07.md",
    size_bytes: 4096,
    modified_at: "2026-08-07T10:00:00Z",
    ...overrides,
  };
}

/**
 * Routes the global invoke mock. `readContent` maps a path to what
 * `samurai_harvest_read` resolves with; an `{ error }` value rejects with
 * that string instead (backend refusals are plain strings, not Error
 * objects). `deleteRejections` maps a path to what `samurai_file_delete`
 * rejects with.
 */
function mockInvoke(
  reports: SamuraiHarvestReport[],
  opts: {
    readContent?: Record<string, string | { error: string }>;
    deleteRejections?: Record<string, string>;
  } = {},
) {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "samurai_harvest_list":
        return reports;
      case "samurai_harvest_read": {
        const { path } = args as { path: string };
        const result = opts.readContent?.[path];
        if (result && typeof result === "object") throw result.error;
        return result ?? "# report body";
      }
      case "samurai_file_delete": {
        const { path } = args as { path: string; force: boolean };
        if (opts.deleteRejections?.[path]) throw opts.deleteRejections[path];
        // Mutate in place — the post-delete refresh() re-lists through the
        // same `reports` array, mirroring a real backend that no longer
        // returns the removed file.
        const remaining = reports.filter((r) => r.path !== path);
        reports.length = 0;
        reports.push(...remaining);
        return undefined;
      }
      default:
        return undefined;
    }
  });
}

describe("HarvestReportsSection (issue #142)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
  });

  it("lists the legacy harvest reports newest first with size and date", async () => {
    // The backend already sorts newest-first (Rust `list_reports`); the
    // section renders in the order it receives, so the mock hands it back
    // pre-sorted exactly like the real command would.
    mockInvoke([
      report({
        path: "C:\\data\\harvest\\newer.md",
        size_bytes: 2048,
        modified_at: "2026-08-07T09:00:00Z",
      }),
      report({
        path: "C:\\data\\harvest\\older.md",
        size_bytes: 1024,
        modified_at: "2026-08-05T09:00:00Z",
      }),
    ]);
    const { container } = render(<HarvestReportsSection />);

    expect(await screen.findByText("older.md")).toBeInTheDocument();
    expect(screen.getByText("newer.md")).toBeInTheDocument();
    expect(screen.getByText("Legacy harvest reports")).toBeInTheDocument();

    // Newest first in DOM order.
    const body = container.textContent ?? "";
    expect(body.indexOf("newer.md")).toBeLessThan(body.indexOf("older.md"));
    expect(screen.getByText(/1 KB/)).toBeInTheDocument();
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
  });

  it("renders nothing when there are no legacy harvest reports", async () => {
    mockInvoke([]);
    const { container } = render(<HarvestReportsSection />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("samurai_harvest_list"));
    // Q4: an empty legacy bucket must render NO chrome — no header, no
    // placeholder, no error-shaped anything.
    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces a failed list inline without losing the panel", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "samurai_harvest_list") throw "harvest directory unreadable";
      return undefined;
    });
    render(<HarvestReportsSection />);
    expect(await screen.findByText("harvest directory unreadable")).toBeInTheDocument();
  });

  it("opens a report in the read-only viewer through samurai_harvest_read", async () => {
    mockInvoke([report({ path: "C:\\data\\harvest\\a.md" })], {
      readContent: { "C:\\data\\harvest\\a.md": "# Harvest body\n\nDetails here." },
    });
    render(<HarvestReportsSection />);
    expect(await screen.findByText("a.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View harvest report: a.md" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_harvest_read", {
        path: "C:\\data\\harvest\\a.md",
      }),
    );
    expect(await screen.findByText("Harvest body")).toBeInTheDocument();
  });

  it("shows the backend refusal verbatim when a report cannot be read", async () => {
    mockInvoke([report({ path: "C:\\data\\harvest\\a.md" })], {
      readContent: {
        "C:\\data\\harvest\\a.md": {
          error: "refusing to read outside the harvest directory: C:\\data\\harvest\\a.md",
        },
      },
    });
    render(<HarvestReportsSection />);
    expect(await screen.findByText("a.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View harvest report: a.md" }));

    expect(
      await screen.findByText(
        "refusing to read outside the harvest directory: C:\\data\\harvest\\a.md",
      ),
    ).toBeInTheDocument();
  });

  it("closes the viewer on Escape", async () => {
    mockInvoke([report({ path: "C:\\data\\harvest\\a.md" })], {
      readContent: { "C:\\data\\harvest\\a.md": "# body" },
    });
    render(<HarvestReportsSection />);
    expect(await screen.findByText("a.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View harvest report: a.md" }));
    expect(
      await screen.findByRole("button", { name: "Close harvest report viewer" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Close harvest report viewer" })).toBeNull(),
    );
  });

  it("deletes a report only after confirming; cancelling calls no backend", async () => {
    mockInvoke([report({ path: "C:\\data\\harvest\\a.md" })]);
    render(<HarvestReportsSection />);
    expect(await screen.findByText("a.md")).toBeInTheDocument();

    const deleteBtn = screen.getByRole("button", { name: "Delete harvest report: a.md" });

    // Cancel: the confirm is asked, but nothing is deleted.
    askMock.mockResolvedValueOnce(false);
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_file_delete", expect.anything());
    expect(screen.getByText("a.md")).toBeInTheDocument();

    // Confirm: deletes with force=false and refreshes.
    askMock.mockResolvedValueOnce(true);
    fireEvent.click(deleteBtn);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_file_delete", {
        path: "C:\\data\\harvest\\a.md",
        force: false,
      }),
    );
    expect(await screen.findByText("Deleted a.md.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("a.md")).toBeNull());
  });

  it("surfaces a failed delete and keeps the row", async () => {
    mockInvoke([report({ path: "C:\\data\\harvest\\a.md" })], {
      deleteRejections: { "C:\\data\\harvest\\a.md": "failed to delete a.md: access denied" },
    });
    render(<HarvestReportsSection />);
    expect(await screen.findByText("a.md")).toBeInTheDocument();

    askMock.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete harvest report: a.md" }));

    expect(await screen.findByText("failed to delete a.md: access denied")).toBeInTheDocument();
    expect(screen.getByText("a.md")).toBeInTheDocument();
  });
});
