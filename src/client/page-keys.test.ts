import { describe, expect, test } from "bun:test";
import { ownsArrowKeys, pageStep, watchPageKeys, type PageStep } from "./page-keys";

interface FakeNode {
  localName: string;
  type?: string;
  isContentEditable?: boolean;
  parentElement: FakeNode | null;
  getAttribute(name: string): string | null;
}

function node(
  localName: string,
  options: {
    type?: string;
    role?: string;
    editable?: boolean;
    parent?: FakeNode | null;
  } = {},
): FakeNode {
  return {
    localName,
    type: options.type,
    isContentEditable: options.editable,
    parentElement: options.parent ?? null,
    getAttribute: (name) => (name === "role" ? (options.role ?? null) : null),
  };
}

const owns = (target: FakeNode | null) => ownsArrowKeys(target as unknown as EventTarget | null);

const key = (name: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: name,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  isComposing: false,
  ...extra,
});

describe("pageStep", () => {
  test("maps the plain arrow keys to a direction", () => {
    expect(pageStep(key("ArrowRight"))).toBe("next");
    expect(pageStep(key("ArrowLeft"))).toBe("prev");
  });

  test("leaves other keys, modified keys and IME composition alone", () => {
    expect(pageStep(key("ArrowUp"))).toBeNull();
    expect(pageStep(key("PageDown"))).toBeNull();
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(pageStep(key("ArrowRight", { [modifier]: true }))).toBeNull();
    }
    expect(pageStep(key("ArrowLeft", { isComposing: true }))).toBeNull();
  });
});

describe("ownsArrowKeys", () => {
  test("text entry and selects keep their arrow keys", () => {
    expect(owns(node("textarea"))).toBe(true);
    expect(owns(node("select"))).toBe(true);
    expect(owns(node("input", { type: "text" }))).toBe(true);
    expect(owns(node("input", { type: "number" }))).toBe(true);
    expect(owns(node("input", { type: "range" }))).toBe(true);
    expect(owns(node("input", { type: "radio" }))).toBe(true);
    expect(owns(node("input"))).toBe(true);
    expect(owns(node("div", { editable: true }))).toBe(true);
  });

  test("a focused checkbox or button does not stop the page from turning", () => {
    expect(owns(node("input", { type: "checkbox" }))).toBe(false);
    expect(owns(node("input", { type: "button" }))).toBe(false);
    expect(owns(node("button"))).toBe(false);
    expect(owns(node("body"))).toBe(false);
  });

  test("widgets with arrow-key roles keep them, also through their descendants", () => {
    expect(owns(node("div", { role: "separator" }))).toBe(true);
    expect(owns(node("div", { role: "slider" }))).toBe(true);
    const tablist = node("div", { role: "tablist" });
    expect(owns(node("button", { role: "tab", parent: tablist }))).toBe(true);
    const editor = node("div", { editable: true });
    expect(owns(node("span", { parent: editor }))).toBe(true);
  });

  test("a role name that only exists on Object.prototype is not a widget", () => {
    expect(owns(node("div", { role: "constructor" }))).toBe(false);
    expect(owns(node("div", { role: "toString" }))).toBe(false);
  });

  test("no target, or a target that is not an element, leaves the key to the page", () => {
    expect(owns(null)).toBe(false);
    expect(ownsArrowKeys({} as EventTarget)).toBe(false);
  });
});

describe("watchPageKeys", () => {
  function fakeDocument() {
    const added: Array<{ type: string; listener: (event: KeyboardEvent) => void; capture: unknown }> = [];
    const removed: typeof added = [];
    const doc = {
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void, capture: unknown) =>
        void added.push({ type, listener, capture }),
      removeEventListener: (type: string, listener: (event: KeyboardEvent) => void, capture: unknown) =>
        void removed.push({ type, listener, capture }),
    };
    return { doc: doc as unknown as Document, added, removed };
  }

  function press(
    name: string,
    target: FakeNode | null,
    extra: Partial<KeyboardEvent> = {},
  ) {
    const calls = { preventDefault: 0, stopPropagation: 0 };
    const event = {
      ...key(name, extra),
      target,
      defaultPrevented: false,
      ...extra,
      preventDefault: () => void (calls.preventDefault += 1),
      stopPropagation: () => void (calls.stopPropagation += 1),
    };
    return { event: event as unknown as KeyboardEvent, calls };
  }

  test("listens in the capture phase and stops listening with the same listener", () => {
    const { doc, added, removed } = fakeDocument();
    const stop = watchPageKeys(doc, () => true);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: "keydown", capture: true });
    stop();
    expect(removed).toEqual(added);
  });

  test("a taken page turn consumes the key", () => {
    const { doc, added } = fakeDocument();
    const turns: PageStep[] = [];
    watchPageKeys(doc, (direction) => {
      turns.push(direction);
      return true;
    });
    const { event, calls } = press("ArrowRight", node("body"));
    added[0]!.listener(event);
    expect(turns).toEqual(["next"]);
    expect(calls).toEqual({ preventDefault: 1, stopPropagation: 1 });
  });

  test("a refused page turn leaves the key to the page", () => {
    const { doc, added } = fakeDocument();
    watchPageKeys(doc, () => false);
    const { event, calls } = press("ArrowLeft", node("body"));
    added[0]!.listener(event);
    expect(calls).toEqual({ preventDefault: 0, stopPropagation: 0 });
  });

  test("keys that belong to a control, a modifier or someone else never reach the handler", () => {
    const { doc, added } = fakeDocument();
    let handled = 0;
    watchPageKeys(doc, () => {
      handled += 1;
      return true;
    });
    const listener = added[0]!.listener;
    listener(press("ArrowRight", node("textarea")).event);
    listener(press("ArrowRight", node("body"), { shiftKey: true }).event);
    listener(press("ArrowRight", node("body"), { defaultPrevented: true }).event);
    listener(press("ArrowDown", node("body")).event);
    expect(handled).toBe(0);
  });
});
