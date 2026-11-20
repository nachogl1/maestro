import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const conf = JSON.parse(
  readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8"),
) as {
  app: { windows: Record<string, unknown>[]; security: { csp: string; devCsp: string } };
};

describe("main window config", () => {
  const mainWindow = conf.app.windows[0];

  it("sets no minimum size so the user resizes the window freely", () => {
    expect(mainWindow).not.toHaveProperty("minWidth");
    expect(mainWindow).not.toHaveProperty("minHeight");
  });

  it("stays resizable", () => {
    expect(mainWindow.resizable).toBe(true);
  });
});

describe("content policy", () => {
  const RULES = ["form-action 'none'", "base-uri 'none'", "object-src 'none'"];

  it.each(["csp", "devCsp"] as const)("%s forbids forms, base addresses and plugins", (key) => {
    const directives = conf.app.security[key].split(";").map((rule) => rule.trim());
    for (const rule of RULES) expect(directives).toContain(rule);
  });
});
