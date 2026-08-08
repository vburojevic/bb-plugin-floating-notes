import { describe, expect, it } from "vitest";
import { deriveTitle, localDateKey, normalizeTags, snippetFromBody } from "./notes";

describe("deriveTitle", () => {
  it("uses the first non-empty line", () => {
    expect(deriveTitle("\n\nShopping list\nmilk")).toBe("Shopping list");
  });
  it("strips markdown heading, list, and quote markers", () => {
    expect(deriveTitle("# Big idea")).toBe("Big idea");
    expect(deriveTitle("- [ ] follow up with Sam")).toBe("follow up with Sam");
    expect(deriveTitle("> quoted thought")).toBe("quoted thought");
  });
  it("caps long titles with an ellipsis", () => {
    const title = deriveTitle("x".repeat(200));
    expect(title.length).toBe(80);
    expect(title.endsWith("…")).toBe(true);
  });
  it("falls back to Untitled for empty bodies", () => {
    expect(deriveTitle("")).toBe("Untitled");
    expect(deriveTitle("   \n\t\n")).toBe("Untitled");
  });
});

describe("snippetFromBody", () => {
  it("returns the text after the title line, collapsed to one line", () => {
    expect(snippetFromBody("# Title\nfirst line\nsecond  line")).toBe("first line second line");
  });
  it("skips leading blank lines when finding the title", () => {
    expect(snippetFromBody("\n\nTitle\nbody")).toBe("body");
  });
  it("returns empty for one-line and empty bodies", () => {
    expect(snippetFromBody("# Just a title")).toBe("");
    expect(snippetFromBody("")).toBe("");
    expect(snippetFromBody("  \n \t")).toBe("");
  });
  it("caps at 160 characters", () => {
    expect(snippetFromBody(`t\n${"x".repeat(300)}`).length).toBe(160);
  });
});

describe("localDateKey", () => {
  it("formats a local calendar date with zero padding", () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("normalizeTags", () => {
  it("lowercases, trims, strips leading #, dedupes, and sorts", () => {
    expect(normalizeTags([" #Work ", "ideas", "WORK", ""])).toEqual(["ideas", "work"]);
  });
  it("returns empty for no usable tags", () => {
    expect(normalizeTags(["", "  ", "#"])).toEqual([]);
  });
});
