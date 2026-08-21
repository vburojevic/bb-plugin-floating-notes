import { describe, expect, it } from "vitest";
import { countTasks, findTaskBoxInLine, toggleTaskAt } from "./tasks";

describe("findTaskBoxInLine", () => {
  it("finds the box in a plain dash task", () => {
    // "- [ ] milk" → box char (the space) is at column 3
    expect(findTaskBoxInLine("- [ ] milk")).toBe(3);
  });

  it("supports *, + and numbered markers", () => {
    expect(findTaskBoxInLine("* [x] a")).toBe(3);
    expect(findTaskBoxInLine("+ [ ] b")).toBe(3);
    expect(findTaskBoxInLine("1. [ ] c")).toBe(4);
    expect(findTaskBoxInLine("12) [X] d")).toBe(5);
  });

  it("accounts for indentation (spaces and tabs)", () => {
    expect(findTaskBoxInLine("  - [ ] nested")).toBe(5);
    expect(findTaskBoxInLine("\t- [x] tabbed")).toBe(4);
  });

  it("accepts an empty task at end of line", () => {
    expect(findTaskBoxInLine("- [ ]")).toBe(3);
    expect(findTaskBoxInLine("- [x]")).toBe(3);
  });

  it("accepts uppercase X", () => {
    expect(findTaskBoxInLine("- [X] shouted")).toBe(3);
  });

  it("rejects non-task lines", () => {
    expect(findTaskBoxInLine("plain text")).toBeNull();
    expect(findTaskBoxInLine("- just a bullet")).toBeNull();
    expect(findTaskBoxInLine("-[ ] no space after marker")).toBeNull();
    expect(findTaskBoxInLine("[ ] no list marker")).toBeNull();
    expect(findTaskBoxInLine("- [y] bad box char")).toBeNull();
    expect(findTaskBoxInLine("- []missing inner space")).toBeNull();
    expect(findTaskBoxInLine("- [ ]tight suffix")).toBeNull();
    expect(findTaskBoxInLine("")).toBeNull();
    expect(findTaskBoxInLine("# heading")).toBeNull();
  });
});

describe("countTasks", () => {
  it("counts nothing in an empty or task-free body", () => {
    expect(countTasks("")).toEqual({ total: 0, done: 0 });
    expect(countTasks("hello\nworld")).toEqual({ total: 0, done: 0 });
  });

  it("counts open and done tasks", () => {
    const body = ["- [ ] one", "- [x] two", "- [X] three", "- plain bullet", "text"].join("\n");
    expect(countTasks(body)).toEqual({ total: 3, done: 2 });
  });

  it("counts indented and numbered tasks", () => {
    const body = ["- [ ] top", "  - [x] nested", "1. [ ] first", "2) [x] second"].join("\n");
    expect(countTasks(body)).toEqual({ total: 4, done: 2 });
  });

  it("ignores checkbox-looking text mid-line", () => {
    expect(countTasks("see - [ ] not at line start")).toEqual({ total: 0, done: 0 });
  });

  it("counts a task on the last line without a trailing newline", () => {
    expect(countTasks("intro\n- [ ] last")).toEqual({ total: 1, done: 0 });
  });
});

describe("toggleTaskAt", () => {
  const body = ["# List", "- [ ] one", "- [x] two", "plain", "  3. [X] three"].join("\n");
  const lineStart = (lineIndex: number): number =>
    body
      .split("\n")
      .slice(0, lineIndex)
      .reduce((offset, line) => offset + line.length + 1, 0);

  it("checks an open task", () => {
    const next = toggleTaskAt(body, lineStart(1));
    expect(next).not.toBeNull();
    expect(next?.split("\n")[1]).toBe("- [x] one");
    // rest of the body is untouched
    expect(next?.split("\n")[0]).toBe("# List");
    expect(next?.split("\n")[2]).toBe("- [x] two");
  });

  it("unchecks a done task", () => {
    const next = toggleTaskAt(body, lineStart(2));
    expect(next?.split("\n")[2]).toBe("- [ ] two");
  });

  it("unchecks an uppercase-X indented numbered task", () => {
    const next = toggleTaskAt(body, lineStart(4));
    expect(next?.split("\n")[4]).toBe("  3. [ ] three");
  });

  it("returns null for a non-task line", () => {
    expect(toggleTaskAt(body, lineStart(0))).toBeNull();
    expect(toggleTaskAt(body, lineStart(3))).toBeNull();
  });

  it("returns null when the offset is not a line start", () => {
    expect(toggleTaskAt(body, lineStart(1) + 2)).toBeNull();
  });

  it("returns null for out-of-range offsets", () => {
    expect(toggleTaskAt(body, -1)).toBeNull();
    expect(toggleTaskAt(body, body.length + 10)).toBeNull();
  });

  it("toggles a task at offset 0", () => {
    expect(toggleTaskAt("- [ ] solo", 0)).toBe("- [x] solo");
  });

  it("toggles the last line without a trailing newline", () => {
    const tail = "text\n- [x] end";
    expect(toggleTaskAt(tail, 5)).toBe("text\n- [ ] end");
  });

  it("toggles an empty task with no text after the box", () => {
    expect(toggleTaskAt("- [ ]", 0)).toBe("- [x]");
  });

  it("round-trips", () => {
    const once = toggleTaskAt(body, lineStart(1));
    expect(once).not.toBeNull();
    const twice = once === null ? null : toggleTaskAt(once, lineStart(1));
    expect(twice).toBe(body);
  });
});
