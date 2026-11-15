import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkshopSummaryCards } from "@/stores/useWorkshopStore";
import { WorkshopCardSummary } from "../WorkshopCardSummary";

/** Invented filler, never real report content. */
const CARDS: WorkshopSummaryCards = {
  verdict: "Most time went on rebuilding a pretend widget; plan it before you build it.",
  problems: [
    {
      title: "Widgets rebuilt twice",
      what: "A made-up widget was built, thrown away and built again.",
      why: "The second build took the whole afternoon.",
      fix: "Write the widget checks before the first build.",
    },
    {
      title: "Gadget tests ran late",
      what: "Invented failures showed up after many files had changed.",
      why: "Finding the breaking change took several rounds.",
      fix: "Run the gadget tests after each change.",
    },
  ],
  ideas: [{ title: "A gizmo command", what: "Save the gizmo steps as a command." }],
  wins: [{ title: "Quick reviews", text: "Every invented change passed review." }],
};

describe("WorkshopCardSummary", () => {
  it("draws the verdict, then the ranked problems with their fixes, then ideas, then wins", () => {
    render(<WorkshopCardSummary summary={CARDS} />);

    const sections = screen.getAllByRole("heading", { level: 2 });
    expect(sections.map((h) => h.textContent)).toEqual([
      "Problems 2",
      "Ideas to try 1",
      "What went well 1",
    ]);
    const verdict = screen.getByText(CARDS.verdict);
    expect(verdict).toHaveTextContent(`This week${CARDS.verdict}`);
    expect(verdict.compareDocumentPosition(sections[0])).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const problems = screen.getAllByRole("article", { name: /Widgets|Gadget/ });
    expect(problems).toHaveLength(2);
    CARDS.problems.forEach((problem, at) => {
      const card = within(problems[at]);
      expect(card.getByRole("heading", { level: 3 })).toHaveTextContent(
        `${at + 1}${problem.title}`,
      );
      expect(card.getByText(problem.what)).toBeInTheDocument();
      expect(card.getByText(problem.why)).toBeInTheDocument();
      expect(card.getByText("Fix:").parentElement).toHaveTextContent(`Fix: ${problem.fix}`);
    });
    expect(screen.getByText(CARDS.ideas[0].what)).toBeInTheDocument();
    expect(screen.getByText(CARDS.wins[0].text)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it.each([
    ["problems", "Problems"],
    ["ideas", "Ideas to try"],
    ["wins", "What went well"],
  ] as const)("hides the %s section, heading included, when it has no items", (list, heading) => {
    render(<WorkshopCardSummary summary={{ ...CARDS, [list]: [] }} />);

    expect(screen.queryByRole("heading", { name: new RegExp(heading) })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("draws every card when two in a section share a title, after switching runs too", () => {
    const twice = <T,>(item: T): T[] => [item, item];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<WorkshopCardSummary summary={CARDS} />);
    rerender(
      <WorkshopCardSummary
        summary={{
          ...CARDS,
          problems: twice(CARDS.problems[0]),
          ideas: twice(CARDS.ideas[0]),
          wins: twice(CARDS.wins[0]),
        }}
      />,
    );

    const warnings = consoleError.mock.calls.map(([message]) => String(message));
    consoleError.mockRestore();

    expect(warnings.filter((message) => message.includes("same key"))).toEqual([]);
    expect(screen.getAllByText(CARDS.problems[0].fix)).toHaveLength(2);
    expect(screen.queryByText(CARDS.problems[1].fix)).toBeNull();
    expect(screen.getAllByText(CARDS.ideas[0].what)).toHaveLength(2);
    expect(screen.getAllByText(CARDS.wins[0].text)).toHaveLength(2);
  });
});
