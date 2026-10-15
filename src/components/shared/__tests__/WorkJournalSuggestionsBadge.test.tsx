import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  useWorkJournalCandidatesStore,
  type WorkJournalCandidate,
} from "@/stores/useWorkJournalCandidatesStore";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";
import {
  useWorkJournalButtonLabel,
  WorkJournalSuggestionsBadge,
  WorkJournalUnsavedDot,
} from "../WorkJournalSuggestionsBadge";

const CANDIDATES_INITIAL = useWorkJournalCandidatesStore.getState();
const JOURNAL_INITIAL = useWorkJournalStore.getState();
const TODAY = "2026-10-15";

function candidate(id: string, state: WorkJournalCandidate["state"]): WorkJournalCandidate {
  return {
    id,
    date: TODAY,
    time: "14:05",
    text: `line ${id}`,
    source: "git",
    state,
    createdAt: "2026-10-15T14:10:00+01:00",
  };
}

/** The top-bar button as TopBar builds it. */
function JournalButton(): JSX.Element {
  const label = useWorkJournalButtonLabel();
  return (
    <button type="button" aria-label={label}>
      <WorkJournalSuggestionsBadge />
      <WorkJournalUnsavedDot />
    </button>
  );
}

describe("Work Journal top-bar button label", () => {
  afterEach(() => {
    useWorkJournalCandidatesStore.setState(CANDIDATES_INITIAL, true);
    useWorkJournalStore.setState(JOURNAL_INITIAL, true);
  });

  it("is just the name with nothing waiting", () => {
    render(<JournalButton />);
    expect(screen.getByRole("button", { name: "Work Journal" })).toBeInTheDocument();
  });

  it("announces today's pending suggestions and unsaved changes", () => {
    render(<JournalButton />);
    act(() => {
      useWorkJournalCandidatesStore.setState({
        today: TODAY,
        byDate: {
          [TODAY]: [
            candidate("a", "pending"),
            candidate("b", "pending"),
            candidate("c", "rejected"),
          ],
        },
      });
    });
    expect(
      screen.getByRole("button", { name: "Work Journal, 2 suggestions waiting" }),
    ).toBeInTheDocument();
    // The visible badge still shows the bare count.
    expect(screen.getByText("2")).toBeInTheDocument();

    act(() => {
      useWorkJournalCandidatesStore.setState({ byDate: { [TODAY]: [candidate("a", "pending")] } });
      useWorkJournalStore.setState({ unsavedDates: [TODAY] });
    });
    expect(
      screen.getByRole("button", { name: "Work Journal, 1 suggestion waiting, unsaved changes" }),
    ).toBeInTheDocument();
  });
});
