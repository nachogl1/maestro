import { describe, expect, it } from "vitest";
import { isDue, withSectionsOpen } from "../workshopReport";

describe("withSectionsOpen", () => {
  it("adds the open-sections style inside the head", () => {
    const html = "<html><head><title>r</title></head><body>x</body></html>";

    const shown = withSectionsOpen(html);

    expect(shown).toContain(".collapsible-content");
    expect(shown.indexOf(".collapsible-content")).toBeLessThan(shown.indexOf("</head>"));
    expect(shown).toContain("<body>x</body>");
  });

  it("puts the style first when the report has no head", () => {
    expect(withSectionsOpen("<p>x</p>").endsWith("<p>x</p>")).toBe(true);
    expect(withSectionsOpen("<p>x</p>")).toContain(".collapsible-content");
  });
});

describe("isDue", () => {
  const now = Date.parse("2026-10-18T09:00:00Z");

  it("is due when it never ran", () => {
    expect(isDue(null, now)).toBe(true);
  });

  it("is due once the next run time has passed", () => {
    expect(isDue("2026-10-18T08:59:00Z", now)).toBe(true);
    expect(isDue("2026-10-18T09:01:00Z", now)).toBe(false);
  });
});
