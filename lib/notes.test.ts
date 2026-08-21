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
  parseSearchQuery,
  referencedAttachmentIds,
  slug,
  snippetFromBody,
  stripAttachmentRefs,
  uncheckedTaskLines,
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

describe("referencedAttachmentIds", () => {
  it("finds ids in image refs and bare urls", () => {
    const body =
      "![shot](bbnote://attachment/abc123def0)\nsee bbnote://attachment/ffff000011";
    expect(referencedAttachmentIds(body)).toEqual(["abc123def0", "ffff000011"]);
  });
  it("dedupes repeated refs, keeping first-use order", () => {
    const body =
      "bbnote://attachment/bbb ![x](bbnote://attachment/aaa) bbnote://attachment/bbb";
    expect(referencedAttachmentIds(body)).toEqual(["bbb", "aaa"]);
  });
  it("returns empty for bodies without refs", () => {
    expect(referencedAttachmentIds("")).toEqual([]);
    expect(referencedAttachmentIds("plain text, no attachments")).toEqual([]);
    expect(referencedAttachmentIds("bbnote://note/abc is not an attachment")).toEqual([]);
  });
});

describe("stripAttachmentRefs", () => {
  it("drops the whole line when the image ref was alone on it", () => {
    const body = "before\n![shot](bbnote://attachment/aaa)\nafter";
    expect(stripAttachmentRefs(body, "aaa")).toBe("before\nafter");
  });
  it("drops a ref-only line even when it is padded with whitespace", () => {
    const body = "before\n  ![shot](bbnote://attachment/aaa)  \nafter";
    expect(stripAttachmentRefs(body, "aaa")).toBe("before\nafter");
  });
  it("keeps the line when text surrounds the ref", () => {
    expect(stripAttachmentRefs("see ![s](bbnote://attachment/aaa) here", "aaa")).toBe(
      "see  here",
    );
  });
  it("strips bare urls", () => {
    expect(stripAttachmentRefs("img at bbnote://attachment/aaa today", "aaa")).toBe(
      "img at  today",
    );
  });
  it("leaves other ids alone, including ids the target prefixes", () => {
    const body =
      "![a](bbnote://attachment/aaa1)\nbbnote://attachment/aaa1 and ![b](bbnote://attachment/bbb)";
    expect(stripAttachmentRefs(body, "aaa")).toBe(body);
  });
  it("returns the body unchanged when the id is absent", () => {
    expect(stripAttachmentRefs("no refs here", "aaa")).toBe("no refs here");
    expect(stripAttachmentRefs("", "aaa")).toBe("");
  });
  it("strips every occurrence across the body", () => {
    const body =
      "![one](bbnote://attachment/aaa)\ntext ![two](bbnote://attachment/aaa) tail";
    expect(stripAttachmentRefs(body, "aaa")).toBe("text  tail");
  });
});

describe("uncheckedTaskLines", () => {
  it("returns only unchecked task lines, indentation preserved", () => {
    const body = [
      "# Daily",
      "- [ ] top level",
      "  - [ ] nested",
      "\t- [ ] tabbed",
      "- [x] done",
      "* [X] also done",
      "1. [ ] ordered",
      "2) [ ] paren ordered",
      "plain line",
    ].join("\n");
    expect(uncheckedTaskLines(body)).toEqual([
      "- [ ] top level",
      "  - [ ] nested",
      "\t- [ ] tabbed",
      "1. [ ] ordered",
      "2) [ ] paren ordered",
    ]);
  });
  it("counts a bare box at end of line, matching countTasks", () => {
    expect(uncheckedTaskLines("- [ ]")).toEqual(["- [ ]"]);
  });
  it("ignores malformed boxes", () => {
    expect(uncheckedTaskLines("- [y] bad\n-[ ] tight\n[ ] bare")).toEqual([]);
  });
  it("caps at 30 lines", () => {
    const body = Array.from({ length: 40 }, (_, i) => `- [ ] task ${i}`).join("\n");
    const lines = uncheckedTaskLines(body);
    expect(lines.length).toBe(30);
    expect(lines[0]).toBe("- [ ] task 0");
    expect(lines[29]).toBe("- [ ] task 29");
  });
  it("returns empty for empty bodies", () => {
    expect(uncheckedTaskLines("")).toEqual([]);
  });
});

describe("parseSearchQuery", () => {
  it("returns plain text untouched", () => {
    expect(parseSearchQuery("hello world")).toEqual({ text: "hello world" });
  });
  it("collapses extra whitespace in the free text", () => {
    expect(parseSearchQuery("  spaced   words  ")).toEqual({ text: "spaced words" });
  });
  it("parses tag: and whole-token # into tag, lowercased", () => {
    expect(parseSearchQuery("tag:Work")).toEqual({ text: "", tag: "work" });
    expect(parseSearchQuery("#API docs")).toEqual({ text: "docs", tag: "api" });
  });
  it("maps in: values to kinds, plurals included, deduplicated", () => {
    expect(parseSearchQuery("in:notes")).toEqual({ text: "", kinds: ["note"] });
    expect(parseSearchQuery("in:scratchpads in:scratchpad")).toEqual({
      text: "",
      kinds: ["scratchpad"],
    });
    expect(parseSearchQuery("in:daily in:inbox")).toEqual({
      text: "",
      kinds: ["daily", "inbox"],
    });
  });
  it("parses in:trash as the trash view", () => {
    expect(parseSearchQuery("in:trash old stuff")).toEqual({
      text: "old stuff",
      view: "trash",
    });
  });
  it("parses is: and thread: operators", () => {
    expect(parseSearchQuery("is:sticky")).toEqual({ text: "", stickyOpen: true });
    expect(parseSearchQuery("is:tasks")).toEqual({ text: "", task: "open" });
    expect(parseSearchQuery("is:open")).toEqual({ text: "", task: "open" });
    expect(parseSearchQuery("is:done")).toEqual({ text: "", task: "done" });
    expect(parseSearchQuery("thread:current")).toEqual({
      text: "",
      threadRef: "current",
    });
  });
  it("keeps unknown operators and values in the text", () => {
    expect(parseSearchQuery("foo:bar baz")).toEqual({ text: "foo:bar baz" });
    expect(parseSearchQuery("in:everything")).toEqual({ text: "in:everything" });
    expect(parseSearchQuery("is:weird")).toEqual({ text: "is:weird" });
  });
  it("keeps bare # and empty tag: in the text", () => {
    expect(parseSearchQuery("# tag:")).toEqual({ text: "# tag:" });
  });
  it("combines operators and text", () => {
    expect(parseSearchQuery("bug tag:work in:notes is:open")).toEqual({
      text: "bug",
      tag: "work",
      kinds: ["note"],
      task: "open",
    });
  });
  it("returns empty text for an empty query", () => {
    expect(parseSearchQuery("")).toEqual({ text: "" });
    expect(parseSearchQuery("   ")).toEqual({ text: "" });
  });
});

describe("slug", () => {
  it("lowercases and joins words with dashes", () => {
    expect(slug("Hello, World!")).toBe("hello-world");
    expect(slug("Release   checklist (v2)")).toBe("release-checklist-v2");
  });
  it("folds diacritics to ascii", () => {
    expect(slug("Café au lait")).toBe("cafe-au-lait");
  });
  it("trims leading and trailing separators", () => {
    expect(slug("--- spaced ---")).toBe("spaced");
  });
  it("caps at 60 chars without a trailing dash", () => {
    expect(slug("a".repeat(100)).length).toBe(60);
    expect(slug(`${"x".repeat(59)} ${"y".repeat(10)}`)).toBe("x".repeat(59));
  });
  it("falls back to untitled when nothing survives", () => {
    expect(slug("")).toBe("untitled");
    expect(slug("!!!")).toBe("untitled");
    expect(slug("日本語")).toBe("untitled");
  });
});
