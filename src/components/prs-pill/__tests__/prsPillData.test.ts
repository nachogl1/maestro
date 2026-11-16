import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checksLabel,
  createdLabel,
  loadProjectPrs,
  type PillPr,
  PR_LIMIT,
  PrsPillDataError,
  readPrs,
  reviewLabel,
  sortPrs,
} from "../prsPillData";

const rawPr = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Made-up change ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`,
  author: { login: "dev-kiwi" },
  isDraft: false,
  createdAt: "2026-11-14T10:00:00Z",
  reviewDecision: "REVIEW_REQUIRED",
  checksSummary: { success: 1, failure: 0, pending: 0, total: 1, verdict: "success" },
  ...extra,
});

const pr = (number: number, createdAt: string): PillPr => ({
  number,
  title: `Made-up change ${number}`,
  url: "",
  author: "dev-kiwi",
  isDraft: false,
  createdAt,
  reviewDecision: null,
  checks: "none",
});

describe("readPrs", () => {
  it("reads the fields the pill shows", () => {
    expect(readPrs([rawPr(7)])).toEqual([
      {
        number: 7,
        title: "Made-up change 7",
        url: "https://github.com/acme/widgets/pull/7",
        author: "dev-kiwi",
        isDraft: false,
        createdAt: "2026-11-14T10:00:00Z",
        reviewDecision: "REVIEW_REQUIRED",
        checks: "success",
      },
    ]);
  });

  it("reads a missing review and an unknown or missing checks verdict as none", () => {
    const [a, b, c] = readPrs([
      rawPr(1, { reviewDecision: "", checksSummary: { verdict: "skipped" } }),
      rawPr(2, { reviewDecision: null, checksSummary: undefined }),
      rawPr(3, { reviewDecision: undefined }),
    ]);
    expect([a.reviewDecision, b.reviewDecision, c.reviewDecision]).toEqual([null, null, null]);
    expect([a.checks, b.checks]).toEqual(["none", "none"]);
  });

  it.each([
    ["no list", null],
    ["an object instead of a list", { number: 1 }],
    ["a null pull request", [null]],
    ["a pull request with no number", [rawPr(1, { number: undefined })]],
    ["a pull request numbered zero", [rawPr(0)]],
    ["a fractional number", [rawPr(1.5)]],
    ["a duplicate", [rawPr(1), rawPr(1)]],
    ["a null author", [rawPr(1, { author: null })]],
    ["an author with no login", [rawPr(1, { author: {} })]],
    ["no draft flag", [rawPr(1, { isDraft: null })]],
    ["no title", [rawPr(1, { title: null })]],
    ["no url", [rawPr(1, { url: 3 })]],
    ["no created date", [rawPr(1, { createdAt: undefined })]],
    ["a review decision that is not text", [rawPr(1, { reviewDecision: 5 })]],
  ])("refuses %s with the one pill error", (_name, raw) => {
    expect(() => readPrs(raw)).toThrow(PrsPillDataError);
  });
});

describe("loadProjectPrs", () => {
  afterEach(() => vi.mocked(invoke).mockReset());

  it("asks github_list_prs for open pull requests and flags a full page as truncated", async () => {
    const full = Array.from({ length: PR_LIMIT }, (_, i) => rawPr(i + 1));
    vi.mocked(invoke)
      .mockResolvedValueOnce([rawPr(1)])
      .mockResolvedValueOnce(full);

    const small = await loadProjectPrs("/work/widgets");
    const big = await loadProjectPrs("/work/widgets");

    expect(invoke).toHaveBeenCalledWith("github_list_prs", {
      repoPath: "/work/widgets",
      state: "open",
      limit: PR_LIMIT,
      search: null,
    });
    expect([small.truncated, big.truncated]).toEqual([false, true]);
  });
});

describe("sortPrs", () => {
  it("puts pull requests waiting for my review first, then newest first", () => {
    const prs = [
      pr(1, "2026-11-09T10:00:00Z"),
      pr(2, "2026-11-15T10:00:00Z"),
      pr(3, "2026-11-14T10:00:00Z"),
      pr(4, "2026-11-16T10:00:00Z"),
    ];
    expect(sortPrs(prs, new Set([1, 3])).map((x) => x.number)).toEqual([3, 1, 4, 2]);
  });
});

describe("detail card labels", () => {
  it("words the checks verdict", () => {
    expect((["success", "failure", "pending", "none"] as const).map((v) => checksLabel(v))).toEqual(
      ["Passing", "Failing", "Running", "No checks"],
    );
  });

  it("words the review decision, unknown ones as GitHub spells them", () => {
    expect(
      [null, "", "APPROVED", "CHANGES_REQUESTED", "review_required", "NEEDS_OWNER"].map(
        reviewLabel,
      ),
    ).toEqual([
      "No review yet",
      "No review yet",
      "Approved",
      "Changes requested",
      "Review required",
      "Needs owner",
    ]);
  });

  it("dates the creation and says how long ago it was", () => {
    const now = new Date(2026, 10, 16, 15, 0);
    expect(
      [
        new Date(2026, 10, 16, 9, 0),
        new Date(2026, 10, 15, 23, 0),
        new Date(2026, 10, 9, 8, 0),
      ].map((d) => createdLabel(d.toISOString(), now)),
    ).toEqual(["16 Nov 2026 (today)", "15 Nov 2026 (yesterday)", "9 Nov 2026 (7 days ago)"]);
    expect(createdLabel("not a date", now)).toBe("Unknown");
  });
});
