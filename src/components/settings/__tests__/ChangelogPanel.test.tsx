import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CHANGELOG } from "@/lib/changelog";
import { ChangelogPanel } from "../ChangelogPanel";

describe("ChangelogPanel", () => {
  it("renders every day and the lines of the latest day", () => {
    render(<ChangelogPanel />);
    for (const entry of CHANGELOG) {
      expect(screen.getByText(entry.date)).toBeTruthy();
    }
    for (const item of CHANGELOG[0].items) {
      expect(screen.getByText(item)).toBeTruthy();
    }
  });
});
