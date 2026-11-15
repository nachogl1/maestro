import { type ReactNode, useId } from "react";
import type { WorkshopSummaryCards } from "@/stores/useWorkshopStore";

interface WorkshopCardSummaryProps {
  summary: WorkshopSummaryCards;
}

interface SummarySectionProps {
  title: string;
  /** Tailwind text colour of the heading. */
  tone: string;
  count: number;
  children: ReactNode;
}

interface SummaryCardProps {
  title: ReactNode;
  /** Extra classes for the card's frame. */
  frame?: string;
  children: ReactNode;
}

/** A coloured section heading with its item count, then its cards; nothing when it has none. */
function SummarySection({ title, tone, count, children }: SummarySectionProps) {
  if (count === 0) return null;
  return (
    <section>
      <h2
        className={`mb-2 mt-[18px] flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.06em] ${tone}`}
      >
        {title}{" "}
        <span className="font-medium normal-case tracking-normal text-maestro-muted">{count}</span>
      </h2>
      {children}
    </section>
  );
}

/** One card, named by its title for screen readers. */
function SummaryCard({
  title,
  frame = "border-maestro-border py-2.5",
  children,
}: SummaryCardProps) {
  const titleId = useId();
  return (
    <article
      aria-labelledby={titleId}
      className={`mb-2 rounded-md border bg-maestro-card px-3 ${frame}`}
    >
      <h3 id={titleId} className="mb-1 text-[13px] font-semibold text-maestro-text">
        {title}
      </h3>
      {children}
    </article>
  );
}

/**
 * The fixed-shape summary of a Workshop run (issue #655), read only: the week's verdict, then
 * up to three problems worst first, each with a green Fix, then ideas to try, then wins.
 */
export function WorkshopCardSummary({ summary }: WorkshopCardSummaryProps) {
  return (
    <div className="px-3.5 pb-5 pt-3.5 text-[13px] leading-normal text-maestro-text">
      <div className="rounded-md border border-maestro-accent/45 bg-maestro-accent/[0.08] px-3 py-2.5 text-sm leading-normal">
        <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-maestro-accent">
          This week
        </span>
        {summary.verdict}
      </div>

      <SummarySection title="Problems" tone="text-maestro-red" count={summary.problems.length}>
        {summary.problems.map((problem, at) => (
          <SummaryCard
            key={problem.title}
            title={
              <>
                <span className="mr-1.5 inline-block h-[18px] w-[18px] rounded-full bg-maestro-red/15 text-center text-[11px] font-bold leading-[18px] text-red-400">
                  {at + 1}
                </span>
                {problem.title}
              </>
            }
          >
            <p className="mb-1 text-maestro-text/85">
              <span className="font-semibold text-maestro-muted">What:</span> {problem.what}
            </p>
            <p className="mb-1 text-maestro-text/85">
              <span className="font-semibold text-maestro-muted">Why it matters:</span>{" "}
              {problem.why}
            </p>
            <p className="mt-2 rounded-[5px] border-l-[3px] border-maestro-green bg-maestro-green/10 px-2.5 py-[7px] text-maestro-text">
              <b className="text-maestro-green">Fix:</b> {problem.fix}
            </p>
          </SummaryCard>
        ))}
      </SummarySection>

      <SummarySection title="Ideas to try" tone="text-maestro-blue" count={summary.ideas.length}>
        {summary.ideas.map((idea) => (
          <SummaryCard key={idea.title} title={idea.title}>
            <p className="mb-1 text-maestro-text">{idea.what}</p>
          </SummaryCard>
        ))}
      </SummarySection>

      <SummarySection title="What went well" tone="text-maestro-green" count={summary.wins.length}>
        {summary.wins.map((win) => (
          <SummaryCard
            key={win.title}
            frame="border-maestro-green/25 py-2"
            title={
              <>
                <span aria-hidden="true" className="text-maestro-green">
                  ✓{" "}
                </span>
                {win.title}
              </>
            }
          >
            <p className="mb-1 text-maestro-text/85">{win.text}</p>
          </SummaryCard>
        ))}
      </SummarySection>
    </div>
  );
}
