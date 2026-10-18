import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface WorkshopSummaryProps {
  markdown: string;
}

/** Reading sizes: bigger text and looser lines than the compact MarkdownBody. */
const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mb-3 mt-6 text-lg font-semibold text-maestro-text first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-6 border-b border-maestro-border/60 pb-1 text-base font-semibold text-maestro-text first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-4 text-sm font-semibold text-maestro-text first:mt-0">{children}</h3>
  ),
  p: ({ children }) => <p className="mb-3 text-sm leading-7 text-maestro-text/90">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-3 ml-5 list-disc space-y-2 text-sm leading-7 text-maestro-text/90">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 ml-5 list-decimal space-y-2 text-sm leading-7 text-maestro-text/90">
      {children}
    </ol>
  ),
  strong: ({ children }) => <strong className="font-semibold text-maestro-text">{children}</strong>,
  code: ({ children }) => (
    <code className="rounded bg-maestro-bg px-1 py-0.5 font-mono text-[13px] text-maestro-text">
      {children}
    </code>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-maestro-accent hover:underline"
    >
      {children}
    </a>
  ),
};

/** The AI summary of a Workshop run, read-only. Raw HTML in it is never rendered. */
export function WorkshopSummary({ markdown }: WorkshopSummaryProps) {
  return (
    <article className="mx-auto max-w-prose px-5 py-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
