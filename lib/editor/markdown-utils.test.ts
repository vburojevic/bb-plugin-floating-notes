import { describe, expect, it } from "vitest";
import {
  isBareUrl,
  isTableDelimiterLine,
  markdownLinkSnippet,
  scanWikiLinks,
  wrapSelectionWith,
} from "./markdown-utils";

describe("scanWikiLinks", () => {
  it("finds a single wiki link with correct offsets", () => {
    // "see [[Target Note]] end" — [[ at 4, ]] ends at 19
    expect(scanWikiLinks("see [[Target Note]] end")).toEqual([
      { from: 4, to: 19, target: "Target Note" },
    ]);
  });

  it("finds a link spanning the whole line", () => {
    expect(scanWikiLinks("[[X]]")).toEqual([{ from: 0, to: 5, target: "X" }]);
  });

  it("finds multiple links on one line", () => {
    const matches = scanWikiLinks("[[a]] mid [[b c]]");
    expect(matches).toEqual([
      { from: 0, to: 5, target: "a" },
      { from: 10, to: 17, target: "b c" },
    ]);
  });

  it("trims the target but keeps raw offsets", () => {
    expect(scanWikiLinks("[[ padded ]]")).toEqual([{ from: 0, to: 12, target: "padded" }]);
  });

  it("skips empty and whitespace-only targets", () => {
    expect(scanWikiLinks("[[]]")).toEqual([]);
    expect(scanWikiLinks("[[   ]]")).toEqual([]);
  });

  it("ignores unclosed, single-bracket, and nested-bracket text", () => {
    expect(scanWikiLinks("[[not closed")).toEqual([]);
    expect(scanWikiLinks("[single] brackets")).toEqual([]);
    expect(scanWikiLinks("plain text")).toEqual([]);
  });

  it("handles extra brackets by matching the innermost pair", () => {
    expect(scanWikiLinks("[[[x]]]")).toEqual([{ from: 1, to: 6, target: "x" }]);
  });

  it("keeps alias-style targets whole", () => {
    expect(scanWikiLinks("[[Note|alias]]")).toEqual([{ from: 0, to: 14, target: "Note|alias" }]);
  });
});

describe("isBareUrl", () => {
  it("accepts bare http(s) URLs", () => {
    expect(isBareUrl("https://example.com")).toBe(true);
    expect(isBareUrl("http://example.com/a/b?c=d#e")).toBe(true);
    expect(isBareUrl("HTTPS://EXAMPLE.COM")).toBe(true);
    expect(isBareUrl("http://localhost:3000")).toBe(true);
  });

  it("tolerates surrounding whitespace (clipboard trailing newline)", () => {
    expect(isBareUrl("https://example.com\n")).toBe(true);
    expect(isBareUrl("  https://example.com  ")).toBe(true);
  });

  it("rejects anything that is not a single URL token", () => {
    expect(isBareUrl("")).toBe(false);
    expect(isBareUrl("hello")).toBe(false);
    expect(isBareUrl("https://example.com and more")).toBe(false);
    expect(isBareUrl("see https://example.com")).toBe(false);
    expect(isBareUrl("https://exa mple.com")).toBe(false);
    expect(isBareUrl("ftp://example.com")).toBe(false);
    expect(isBareUrl("example.com")).toBe(false);
    expect(isBareUrl("https://")).toBe(false);
    expect(isBareUrl("<https://example.com>")).toBe(false);
  });
});

describe("wrapSelectionWith", () => {
  it("wraps a plain selection", () => {
    // "hello world", select "world" (6..11)
    expect(wrapSelectionWith("**", "hello world", 6, 11)).toEqual({
      changes: [
        { from: 6, to: 6, insert: "**" },
        { from: 11, to: 11, insert: "**" },
      ],
      anchor: 8,
      head: 13,
    });
  });

  it("wraps an empty selection (caret lands between the markers)", () => {
    expect(wrapSelectionWith("**", "ab", 1, 1)).toEqual({
      changes: [
        { from: 1, to: 1, insert: "**" },
        { from: 1, to: 1, insert: "**" },
      ],
      anchor: 3,
      head: 3,
    });
  });

  it("unwraps when the marker surrounds the selection", () => {
    // "**bold**", select "bold" (2..6)
    expect(wrapSelectionWith("**", "**bold**", 2, 6)).toEqual({
      changes: [
        { from: 0, to: 2, insert: "" },
        { from: 6, to: 8, insert: "" },
      ],
      anchor: 0,
      head: 4,
    });
  });

  it("unwraps when the marker is inside the selection", () => {
    // select "**bold**" (0..8)
    expect(wrapSelectionWith("**", "**bold**", 0, 8)).toEqual({
      changes: [
        { from: 0, to: 2, insert: "" },
        { from: 6, to: 8, insert: "" },
      ],
      anchor: 0,
      head: 4,
    });
  });

  it("does not unwrap a selection that is only the marker twice", () => {
    // "****" selected (0..4) is startsWith+endsWith but len == 2*marker:
    // it IS unwrapped (empty bold). Verify the boundary condition len >= 2*marker.
    expect(wrapSelectionWith("**", "****", 0, 4).head).toBe(0);
    // "**" selected (0..2) must wrap, not unwrap.
    expect(wrapSelectionWith("**", "**", 0, 2)).toEqual({
      changes: [
        { from: 0, to: 0, insert: "**" },
        { from: 2, to: 2, insert: "**" },
      ],
      anchor: 2,
      head: 4,
    });
  });

  it("works with single-char and strikethrough markers", () => {
    expect(wrapSelectionWith("*", "hi", 0, 2).changes).toEqual([
      { from: 0, to: 0, insert: "*" },
      { from: 2, to: 2, insert: "*" },
    ]);
    expect(wrapSelectionWith("~~", "~~gone~~", 2, 6)).toEqual({
      changes: [
        { from: 0, to: 2, insert: "" },
        { from: 6, to: 8, insert: "" },
      ],
      anchor: 0,
      head: 4,
    });
  });

  it("wraps at document edges without reading out of range", () => {
    expect(wrapSelectionWith("~~", "abc", 0, 3)).toEqual({
      changes: [
        { from: 0, to: 0, insert: "~~" },
        { from: 3, to: 3, insert: "~~" },
      ],
      anchor: 2,
      head: 5,
    });
  });
});

describe("markdownLinkSnippet", () => {
  it("wraps a selection and selects the url placeholder", () => {
    const snippet = markdownLinkSnippet("bb docs");
    expect(snippet.text).toBe("[bb docs](url)");
    expect(snippet.text.slice(snippet.anchor, snippet.head)).toBe("url");
  });

  it("puts the caret in the label for an empty selection", () => {
    expect(markdownLinkSnippet("")).toEqual({ text: "[](url)", anchor: 1, head: 1 });
  });
});

describe("isTableDelimiterLine", () => {
  it("accepts delimiter rows", () => {
    expect(isTableDelimiterLine("|---|---|")).toBe(true);
    expect(isTableDelimiterLine("| :--- | :-: | ---: |")).toBe(true);
    expect(isTableDelimiterLine("  |-|-|  ")).toBe(true);
    expect(isTableDelimiterLine("---|---")).toBe(true);
  });

  it("rejects header/data rows and non-table lines", () => {
    expect(isTableDelimiterLine("| a | b |")).toBe(false);
    expect(isTableDelimiterLine("| 1 | 2 |")).toBe(false);
    expect(isTableDelimiterLine("")).toBe(false);
    expect(isTableDelimiterLine("|||")).toBe(false); // no dash
    expect(isTableDelimiterLine("plain text")).toBe(false);
  });
});
