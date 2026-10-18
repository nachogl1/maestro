import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CHANGELOG } from "@/lib/changelog";
import { ChangelogPanel } from "../ChangelogPanel";

describe("ChangelogPanel", () => {
  it("renders every changelog entry title and the latest date", () => {
    render(<ChangelogPanel />);
    for (const entry of CHANGELOG) {
      expect(screen.getByText(entry.title)).toBeTruthy();
    }
    expect(screen.getAllByText(CHANGELOG[0].date).length).toBeGreaterThan(0);
  });

  it("lists entries newest first", () => {
    const dates = CHANGELOG.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
