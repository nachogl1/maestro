import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CHANGELOG } from "@/lib/changelog";
import { ChangelogModal } from "../ChangelogModal";

describe("ChangelogModal", () => {
  it("renders every changelog entry title and the latest date", () => {
    render(<ChangelogModal onClose={vi.fn()} />);
    for (const entry of CHANGELOG) {
      expect(screen.getByText(entry.title)).toBeTruthy();
    }
    expect(screen.getAllByText(CHANGELOG[0].date).length).toBeGreaterThan(0);
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<ChangelogModal onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close changelog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists entries newest first", () => {
    const dates = CHANGELOG.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
