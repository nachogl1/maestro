import { describe, expect, it } from "vitest";
import { sessionDisplayName } from "../sessionDisplayName";

describe("sessionDisplayName", () => {
  it("uses the trimmed session name when there is one", () => {
    expect(sessionDisplayName({ id: 7, name: "  harvest  " })).toBe("harvest");
  });

  it("falls back to Terminal <session id> for a missing or blank name", () => {
    expect(sessionDisplayName({ id: 7 })).toBe("Terminal 7");
    expect(sessionDisplayName({ id: 7, name: null })).toBe("Terminal 7");
    expect(sessionDisplayName({ id: 7, name: "   " })).toBe("Terminal 7");
  });
});
