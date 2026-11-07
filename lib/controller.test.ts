import { afterEach, describe, expect, it, vi } from "vitest";
import { controller } from "./controller";

const ids = () => controller.get().visibleThreads.map((thread) => thread.threadId);

afterEach(() => controller.setVisibleThreads([]));

describe("visible threads", () => {
  it("puts newly seen threads first and keeps the rest in order", () => {
    controller.setVisibleThreads([{ threadId: "a", projectId: "p" }]);
    controller.setVisibleThreads([
      { threadId: "a", projectId: "p" },
      { threadId: "b", projectId: "p" },
    ]);
    expect(ids()).toEqual(["b", "a"]);
    expect(controller.activeThread()?.threadId).toBe("b");
  });

  it("puts the focused thread first", () => {
    controller.setVisibleThreads(
      [
        { threadId: "a", projectId: "p" },
        { threadId: "b", projectId: "q" },
      ],
      "a",
    );
    expect(ids()).toEqual(["a", "b"]);
  });

  it("drops threads that left the screen and picks up resolved projects", () => {
    controller.setVisibleThreads([
      { threadId: "a", projectId: null },
      { threadId: "b", projectId: null },
    ]);
    controller.setVisibleThreads([{ threadId: "a", projectId: "p" }]);
    expect(controller.get().visibleThreads).toEqual([{ threadId: "a", projectId: "p" }]);
    expect(controller.isThreadVisible("b")).toBe(false);
  });

  it("does not notify when nothing changed", () => {
    controller.setVisibleThreads([{ threadId: "a", projectId: "p" }]);
    const listener = vi.fn();
    const off = controller.subscribe(listener);
    controller.setVisibleThreads([{ threadId: "a", projectId: "p" }]);
    off();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("navigation", () => {
  it("posts a request while a bridge is mounted, and stops after it unmounts", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    const dispose = controller.registerNavigator();
    controller.openThread("t1");
    expect(controller.get().navigateRequest?.threadId).toBe("t1");
    controller.consumeNavigation(controller.get().navigateRequest!.seq);
    dispose();
    controller.openThread("t2");
    expect(controller.get().navigateRequest).toBeNull();
    expect(assign).toHaveBeenCalledWith("/threads/t2");
    vi.unstubAllGlobals();
  });
});
