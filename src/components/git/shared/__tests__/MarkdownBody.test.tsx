import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { MarkdownBody } from "../MarkdownBody";

const RENDERED_MARKER = "rendered-marker";

/** The renderer loads its plugins on demand; loading them once up front keeps each test fast. */
beforeAll(async () => {
  await Promise.all([
    import("react-markdown"),
    import("rehype-raw"),
    import("rehype-sanitize"),
    import("remark-gfm"),
    import("remark-gemoji"),
  ]);
});

async function renderMarkdown(content: string, allowRawHtml?: boolean): Promise<HTMLElement> {
  const { container } = render(
    <MarkdownBody content={`${content}\n\n${RENDERED_MARKER}`} allowRawHtml={allowRawHtml} />,
  );
  await screen.findByText(RENDERED_MARKER);
  return container;
}

const DROPPED_HTML: { html: string; selector: string }[] = [
  { html: '<meta name="sample" content="sample">', selector: "meta" },
  { html: '<form action="https://example.com/"><button>Send</button></form>', selector: "form" },
  { html: '<form action="https://example.com/"><button>Send</button></form>', selector: "button" },
  { html: "<style>p { color: red; }</style>", selector: "style" },
  { html: '<base href="https://example.com/">', selector: "base" },
  { html: '<iframe src="https://example.com/"></iframe>', selector: "iframe" },
  { html: '<span onerror="void 0">sample</span>', selector: "[onerror]" },
  { html: "<script>void 0</script>", selector: "script" },
  { html: '<object data="https://example.com/sample.bin"></object>', selector: "object" },
  { html: '<embed src="https://example.com/sample.bin">', selector: "embed" },
  { html: '<link rel="stylesheet" href="https://example.com/sample.css">', selector: "link" },
];

describe("MarkdownBody", () => {
  it.each(
    [true, false].flatMap((allowRawHtml) =>
      DROPPED_HTML.map((input) => ({ ...input, allowRawHtml })),
    ),
  )("leaves out $selector from $html when allowRawHtml is $allowRawHtml", async ({
    html,
    selector,
    allowRawHtml,
  }) => {
    const container = await renderMarkdown(html, allowRawHtml);
    expect(container.querySelector(selector)).toBeNull();
  });

  it("keeps images, tables, collapsible sections, keys, code blocks and task lists", async () => {
    const container = await renderMarkdown(
      [
        "# Sample heading",
        "",
        '<img src="https://example.com/sample.png" width="120" alt="sample image">',
        "",
        "| Name | Value |",
        "|---|---|",
        "| one | 1 |",
        "",
        "<details><summary>More detail</summary>",
        "",
        "Hidden text",
        "",
        "</details>",
        "",
        "Press <kbd>Ctrl</kbd>, H<sub>2</sub>O and x<sup>2</sup>, see [the link](https://example.com/).",
        "",
        "```ts",
        "const sample = 1;",
        "```",
        "",
        "- [x] finished task",
      ].join("\n"),
    );

    expect(container.querySelector("h1")?.textContent).toBe("Sample heading");
    expect(container.querySelector('img[src="https://example.com/sample.png"]')).not.toBeNull();
    expect(container.querySelector("table td")?.textContent).toBe("one");
    expect(container.querySelector("details > summary")?.textContent).toBe("More detail");
    expect(container.querySelector("details")?.textContent).toContain("Hidden text");
    expect(container.querySelector("kbd")?.textContent).toBe("Ctrl");
    expect(container.querySelector("sub")?.textContent).toBe("2");
    expect(container.querySelector("sup")?.textContent).toBe("2");
    expect(container.querySelector('a[href="https://example.com/"]')?.textContent).toBe("the link");
    // A block keeps its language class, so the styling map renders it as a block, not inline code.
    expect(container.querySelector("pre > code")?.className).toBe("text-maestro-text");
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.disabled).toBe(true);
  });
});
