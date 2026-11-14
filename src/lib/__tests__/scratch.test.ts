import { describe, expect, it } from "vitest";
import { defaultScratchName, formatScratchAge, isScratchPath, isScratchProject } from "../scratch";

describe("defaultScratchName", () => {
  it("names a scratch project after the day, month and time", () => {
    expect(defaultScratchName(new Date(2026, 10, 13, 18, 22))).toBe("scratch-13-nov-1822");
    expect(defaultScratchName(new Date(2026, 0, 2, 7, 5))).toBe("scratch-2-jan-0705");
  });
});

describe("formatScratchAge", () => {
  it("says how old a scratch project is in the largest whole unit", () => {
    const now = Date.UTC(2026, 10, 13, 12, 0);
    const cases: Array<[number, string]> = [
      [now - 30_000, "now"],
      [now - 5 * 60_000, "5 min"],
      [now - 3 * 3_600_000, "3 h"],
      [now - 2 * 86_400_000, "2 d"],
      [now + 60_000, "now"],
    ];
    for (const [createdAt, expected] of cases) {
      expect(formatScratchAge(createdAt, now)).toBe(expected);
    }
  });
});

describe("isScratchPath", () => {
  it("counts only direct subfolders of the scratch folder, in any spelling", () => {
    const folder = "C:\\Users\\someone\\Maestro Scratch";
    const cases: Array<[string, boolean]> = [
      ["C:\\Users\\someone\\Maestro Scratch\\demo", true],
      ["c:/users/someone/maestro scratch/demo/", true],
      ["\\\\?\\C:\\Users\\someone\\Maestro Scratch\\demo", true],
      ["C:\\Users\\someone\\Maestro Scratch\\demo\\nested", false],
      ["C:\\Users\\someone\\Maestro Scratch", false],
      ["C:\\git\\real-project", false],
    ];
    for (const [path, expected] of cases) {
      expect(isScratchPath(path, folder), path).toBe(expected);
    }
  });

  it("counts nothing before the scratch folder is known", () => {
    expect(isScratchPath("/home/someone/Maestro Scratch/demo", null)).toBe(false);
  });
});

describe("isScratchProject", () => {
  it("counts only a listed scratch project, never another folder in the scratch folder", () => {
    const folder = "C:\\Users\\someone\\Maestro Scratch";
    const listed = [{ path: "C:\\Users\\someone\\Maestro Scratch\\demo" }];
    const cases: Array<[string, boolean]> = [
      ["C:\\Users\\someone\\Maestro Scratch\\demo", true],
      ["\\\\?\\c:\\users\\someone\\maestro scratch\\DEMO", true],
      ["C:\\Users\\someone\\Maestro Scratch\\real-work", false],
      ["C:\\Users\\someone\\Maestro Scratch\\demo\\nested", false],
      ["C:\\git\\real-project", false],
    ];
    for (const [path, expected] of cases) {
      expect(isScratchProject(path, folder, listed), path).toBe(expected);
    }
  });

  it("counts nothing before the scratch projects are listed", () => {
    const path = "/home/someone/Maestro Scratch/demo";
    expect(isScratchProject(path, "/home/someone/Maestro Scratch", [])).toBe(false);
    expect(isScratchProject(path, null, [{ path }])).toBe(false);
  });
});
