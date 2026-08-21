import { describe, expect, it } from "vitest";
import {
  alignColumns,
  appendToBody,
  countTasks,
  deriveTitle,
  extractHashtags,
  ftsQuery,
  highlightRuns,
  localDateKey,
  normalizeTags,
  snippetFromBody,
} from "./notes";

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

describe("highlightRuns", () => {
  it("splits into alternating plain and matched runs", () => {
    expect(highlightRuns("Release checklist", "check")).toEqual(["Release ", "check", "list"]);
  });
  it("matches case-insensitively and keeps the original casing", () => {
    expect(highlightRuns("Release Checklist", "check")).toEqual(["Release ", "Check", "list"]);
  });
  it("finds every occurrence", () => {
    expect(highlightRuns("aXaXa", "x")).toEqual(["a", "X", "a", "X", "a"]);
  });
  it("returns one plain run for an empty or unmatched query", () => {
    expect(highlightRuns("Release", "")).toEqual(["Release"]);
    expect(highlightRuns("Release", "  ")).toEqual(["Release"]);
    expect(highlightRuns("Release", "zzz")).toEqual(["Release"]);
  });
  it("rejoins to the original text", () => {
    expect(highlightRuns("Meeting notes — infra sync", "n").join("")).toBe("Meeting notes — infra sync");
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

describe("countTasks", () => {
  it("counts bullet and ordered task lines, done = x or X", () => {
    const body = [
      "- [ ] open",
      "- [x] closed",
      "* [X] also closed",
      "+ [ ] plus bullet",
      "1. [ ] ordered dot",
      "2) [x] ordered paren",
    ].join("\n");
    expect(countTasks(body)).toEqual({ total: 6, done: 3 });
  });
  it("counts indented tasks", () => {
    expect(countTasks("  - [ ] nested\n\t- [x] tabbed")).toEqual({ total: 2, done: 1 });
  });
  it("counts a bare box at end of line, matching the editor", () => {
    // A freshly typed `- [x]` with nothing after it is a task — the editor's
    // TASK_LINE_RE says so, and the server must agree or the rings drift.
    expect(countTasks("- [x]")).toEqual({ total: 1, done: 1 });
  });
  it("ignores non-task lines and malformed boxes", () => {
    const body = [
      "plain text",
      "- normal bullet",
      "- [y] bad mark",
      "-[ ] missing space after bullet",
      "[x] no bullet",
    ].join("\n");
    expect(countTasks(body)).toEqual({ total: 0, done: 0 });
  });
  it("returns zeros for an empty body", () => {
    expect(countTasks("")).toEqual({ total: 0, done: 0 });
  });
});

describe("ftsQuery", () => {
  it("quotes a single term and adds a prefix star", () => {
    expect(ftsQuery("hello")).toBe('"hello"*');
  });
  it("joins terms with implicit AND, prefix only on the last", () => {
    expect(ftsQuery("meeting notes")).toBe('"meeting" "notes"*');
  });
  it("escapes embedded double quotes by doubling them", () => {
    expect(ftsQuery('say "hi"')).toBe('"say" """hi"""*');
  });
  it("neutralizes FTS operators by quoting", () => {
    expect(ftsQuery("a AND b*")).toBe('"a" "AND" "b*"*');
  });
  it("trims and collapses whitespace", () => {
    expect(ftsQuery("  a \t b  ")).toBe('"a" "b"*');
  });
  it("returns empty for blank input", () => {
    expect(ftsQuery("")).toBe("");
    expect(ftsQuery("   ")).toBe("");
  });
});

describe("appendToBody", () => {
  it("returns the text alone for an empty body", () => {
    expect(appendToBody("", "hi")).toBe("hi");
  });
  it("inserts a newline when the body lacks a trailing one", () => {
    expect(appendToBody("line", "next")).toBe("line\nnext");
  });
  it("reuses a single trailing newline instead of doubling it", () => {
    expect(appendToBody("line\n", "next")).toBe("line\nnext");
  });
  it("preserves an intentional blank line at the end", () => {
    expect(appendToBody("line\n\n", "next")).toBe("line\n\nnext");
  });
});

describe("alignColumns", () => {
  it("pads every column but the last to the widest cell", () => {
    expect(
      alignColumns([
        ["a", "bb", "c"],
        ["dd", "e", "f"],
      ]),
    ).toBe("a   bb  c\ndd  e   f");
  });
  it("trims trailing whitespace when the last cell is empty", () => {
    expect(alignColumns([["id", ""]])).toBe("id");
  });
  it("handles a single row and single column", () => {
    expect(alignColumns([["only"]])).toBe("only");
  });
});

describe("extractHashtags", () => {
  it("finds inline tags and lowercases them", () => {
    expect(extractHashtags("ship the #Roadmap and #api-v2 today")).toEqual([
      "api-v2",
      "roadmap",
    ]);
  });
  it("ignores markdown headings, numeric refs, and mid-word hashes", () => {
    expect(extractHashtags("# Title\nfix #123 in foo#bar")).toEqual([]);
  });
  it("accepts tags at line start and after parens, deduplicated", () => {
    expect(extractHashtags("#todo\n(see #todo)")).toEqual(["todo"]);
  });
  it("requires a leading letter and at least two characters", () => {
    expect(extractHashtags("#a #_x #9lives #ok")).toEqual(["ok"]);
  });
});
