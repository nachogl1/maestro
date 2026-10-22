import { describe, expect, it } from "vitest";
import { buildChangelog, CHANGELOG } from "../changelog";

describe("buildChangelog", () => {
  it("groups one-line files by day, newest day first and newest name first within a day", () => {
    const entries = buildChangelog({
      "../../docs/changelog/2026-10-01-fix-a.md": "An older fix.\n",
      "../../docs/changelog/2026-10-22-feat-a.md": "- First feature of the day.\n",
      "../../docs/changelog/2026-10-22-feat-b.md":
        "\n\nSecond feature of the day.\nMore prose that is ignored.\n",
    });
    expect(entries).toEqual([
      { date: "2026-10-22", items: ["Second feature of the day.", "First feature of the day."] },
      { date: "2026-10-01", items: ["An older fix."] },
    ]);
  });

  it("leaves out the folder README and files with no text", () => {
    const entries = buildChangelog({
      "../../docs/changelog/README.md": "# Changelog\n",
      "../../docs/changelog/2026-10-22-empty.md": "   \n",
      "../../docs/changelog/2026-10-22-feat-a.md": "A line.\n",
    });
    expect(entries).toEqual([{ date: "2026-10-22", items: ["A line."] }]);
  });
});

describe("CHANGELOG", () => {
  it("is read from docs/changelog and lists days newest first", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    const dates = CHANGELOG.map((entry) => entry.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
