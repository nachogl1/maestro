import { fireEvent, render, screen, within } from "@testing-library/react";
import type { JSONContent } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_PAGE_BODY,
  WEEKEND_PAGE_BODY,
  type WorkJournalPage,
} from "@/stores/useWorkJournalStore";
import {
  countWorkJournalEntries,
  WorkJournalDayList,
  workJournalDayStatus,
} from "../WorkJournalDayList";

function lines(...texts: string[]): JSONContent {
  return {
    type: "doc",
    content: texts.map((text) =>
      text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" },
    ),
  };
}

function page(date: string, title: string, body: JSONContent): WorkJournalPage {
  return { date, title, body, origin: "auto" };
}

// 2026-10-10 and 2026-10-11 are a Saturday and a Sunday.
const PAGES: Record<string, WorkJournalPage> = {
  "2026-10-09": page("2026-10-09", "Fri 9 Oct 2026", lines("09:10 - Review", "", "11:30 - Ship")),
  "2026-10-10": page("2026-10-10", "Sat 10 Oct 2026", WEEKEND_PAGE_BODY),
  "2026-10-11": page("2026-10-11", "Sun 11 Oct 2026", lines("Weekend", "Fixed the build")),
  "2026-10-12": page("2026-10-12", "Mon 12 Oct 2026", EMPTY_PAGE_BODY),
  "2026-10-14": page("2026-10-14", "Wed 14 Oct 2026", lines("09:00 - Standup")),
};

describe("countWorkJournalEntries", () => {
  it("counts non-empty lines, list items included", () => {
    expect(countWorkJournalEntries(EMPTY_PAGE_BODY)).toBe(0);
    expect(countWorkJournalEntries(lines("a", "", "  ", "b"))).toBe(2);
    const list: JSONContent = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Done" }] },
        {
          type: "taskList",
          content: [
            { type: "taskItem", content: [lines("one").content?.[0] ?? {}] },
            { type: "taskItem", content: [lines("two").content?.[0] ?? {}] },
          ],
        },
      ],
    };
    expect(countWorkJournalEntries(list)).toBe(3);
  });
});

describe("workJournalDayStatus", () => {
  it("shows suggestions first, then Weekend, then the entries count", () => {
    expect(workJournalDayStatus(PAGES["2026-10-14"], 3)).toBe("3 suggestions");
    expect(workJournalDayStatus(PAGES["2026-10-14"], 1)).toBe("1 suggestion");
    expect(workJournalDayStatus(PAGES["2026-10-14"], 0)).toBe("1 entry");
    expect(workJournalDayStatus(PAGES["2026-10-09"], 0)).toBe("2 entries");
    expect(workJournalDayStatus(PAGES["2026-10-12"], 0)).toBe("No entries");
    expect(workJournalDayStatus(PAGES["2026-10-10"], 0)).toBe("Weekend");
    // A weekend the user worked on counts its entries.
    expect(workJournalDayStatus(PAGES["2026-10-11"], 0)).toBe("2 entries");
  });
});

describe("WorkJournalDayList", () => {
  it("lists every page newest first with its title and status", () => {
    render(
      <WorkJournalDayList
        pages={PAGES}
        viewedDate="2026-10-14"
        pendingByDate={{ "2026-10-14": 3 }}
        onSelect={() => {}}
      />,
    );
    const rows = within(screen.getByRole("navigation", { name: "Days" })).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Wed 14 Oct 20263 suggestions",
      "Mon 12 Oct 2026No entries",
      "Sun 11 Oct 20262 entries",
      "Sat 10 Oct 2026Weekend",
      "Fri 9 Oct 20262 entries",
    ]);
    expect(rows[0]).toHaveAttribute("aria-current", "date");
    expect(rows[1]).not.toHaveAttribute("aria-current");
  });

  it("dims weekend pages only", () => {
    render(
      <WorkJournalDayList pages={PAGES} viewedDate={null} pendingByDate={{}} onSelect={() => {}} />,
    );
    const dimmed = screen
      .getAllByRole("button")
      .filter((row) => row.className.includes("opacity-50"))
      .map((row) => row.textContent);
    expect(dimmed).toEqual(["Sun 11 Oct 20262 entries", "Sat 10 Oct 2026Weekend"]);
  });

  it("selects the clicked day", () => {
    const onSelect = vi.fn();
    render(
      <WorkJournalDayList
        pages={PAGES}
        viewedDate="2026-10-14"
        pendingByDate={{}}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Fri 9 Oct 2026/ }));
    expect(onSelect).toHaveBeenCalledWith("2026-10-09");
  });
});
