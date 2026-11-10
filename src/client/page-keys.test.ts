import { describe, expect, test } from "bun:test";
import {
  ownsArrowKeys,
  ownsEnterKeys,
  readerShortcut,
  watchReaderKeys,
  type ReaderShortcut,
} from "./page-keys";

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
const ownsEnter = (target: FakeNode | null) =>
  ownsEnterKeys(target as unknown as EventTarget | null);

const key = (name: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: name,
  code: name.startsWith("Digit") ? name : "",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  isComposing: false,
  repeat: false,
  ...extra,
});

describe("readerShortcut", () => {
  test("maps the plain arrow keys to a page step", () => {
    expect(readerShortcut(key("ArrowRight"))).toEqual({ type: "step", direction: "next" });
    expect(readerShortcut(key("ArrowLeft"))).toEqual({ type: "step", direction: "prev" });
  });

  test("a plain Enter translates and a repeat or held key does not", () => {
    expect(readerShortcut(key("Enter"))).toEqual({ type: "translate" });
    expect(readerShortcut(key("Enter", { repeat: true }))).toBeNull();
    expect(readerShortcut(key("Enter", { isComposing: true }))).toBeNull();
    expect(readerShortcut(key("Enter", { ctrlKey: true }))).toBeNull();
  });

  test("Ctrl and Ctrl+Shift digits choose a layout by key code", () => {
    for (const preset of [1, 2, 3, 4, 5] as const) {
      expect(readerShortcut(key(`Digit${preset}`, { ctrlKey: true }))).toEqual({
        type: "layout",
        preset,
      });
      expect(
        readerShortcut(key(`Digit${preset}`, { ctrlKey: true, shiftKey: true })),
      ).toEqual({ type: "layout", preset });
    }
    // Shift changes `key` to a symbol but not the physical code.
    expect(readerShortcut(key("!", { code: "Digit1", ctrlKey: true, shiftKey: true }))).toEqual({
      type: "layout",
      preset: 1,
    });
    expect(readerShortcut(key("Digit6", { ctrlKey: true }))).toBeNull();
    expect(readerShortcut(key("Digit1", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(readerShortcut(key("Digit1", { ctrlKey: true, repeat: true }))).toBeNull();
  });

  test("F toggles immersive reading without repeating", () => {
    expect(readerShortcut(key("f"))).toEqual({ type: "toggle-immersive" });
    expect(readerShortcut(key("F"))).toEqual({ type: "toggle-immersive" });
    expect(readerShortcut(key("f", { repeat: true }))).toBeNull();
    expect(readerShortcut(key("f", { ctrlKey: true }))).toBeNull();
    expect(readerShortcut(key("f", { metaKey: true }))).toBeNull();
    expect(readerShortcut(key("f", { altKey: true }))).toBeNull();
    expect(readerShortcut(key("f", { shiftKey: true }))).toBeNull();
  });

  test("Escape asks to leave immersive reading", () => {
    expect(readerShortcut(key("Escape"))).toEqual({ type: "exit-immersive" });
    expect(readerShortcut(key("Escape", { shiftKey: true }))).toBeNull();
  });

  test("leaves other keys and IME composition alone", () => {
    expect(readerShortcut(key("ArrowUp"))).toBeNull();
    expect(readerShortcut(key("PageDown"))).toBeNull();
    expect(readerShortcut(key("ArrowLeft", { isComposing: true }))).toBeNull();
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(readerShortcut(key("ArrowRight", { [modifier]: true }))).toBeNull();
    }
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

describe("ownsEnterKeys", () => {
  test("controls that act on Enter keep it", () => {
    expect(ownsEnter(node("button"))).toBe(true);
    expect(ownsEnter(node("summary"))).toBe(true);
    expect(ownsEnter(node("a"))).toBe(true);
    expect(ownsEnter(node("input", { type: "text" }))).toBe(true);
    expect(ownsEnter(node("input", { type: "checkbox" }))).toBe(true);
    expect(ownsEnter(node("textarea"))).toBe(true);
    expect(ownsEnter(node("select"))).toBe(true);
    expect(ownsEnter(node("div", { editable: true }))).toBe(true);
    expect(ownsEnter(node("div", { role: "button" }))).toBe(true);
    expect(ownsEnter(node("span", { parent: node("button") }))).toBe(true);
  });

  test("the page body and presentational nodes leave Enter to translation", () => {
    expect(ownsEnter(node("body"))).toBe(false);
    expect(ownsEnter(node("div"))).toBe(false);
    expect(ownsEnter(node("pre"))).toBe(false);
    expect(ownsEnter(null)).toBe(false);
  });
});

describe("watchReaderKeys", () => {
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
    const stop = watchReaderKeys(doc, () => true);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: "keydown", capture: true });
    stop();
    expect(removed).toEqual(added);
  });

  test("a taken shortcut consumes the key", () => {
    const { doc, added } = fakeDocument();
    const seen: ReaderShortcut[] = [];
    watchReaderKeys(doc, (shortcut) => {
      seen.push(shortcut);
      return true;
    });
    const { event, calls } = press("Enter", node("body"));
    added[0]!.listener(event);
    expect(seen).toEqual([{ type: "translate" }]);
    expect(calls).toEqual({ preventDefault: 1, stopPropagation: 1 });
  });

  test("a refused shortcut leaves the key to the page", () => {
    const { doc, added } = fakeDocument();
    watchReaderKeys(doc, () => false);
    const { event, calls } = press("ArrowLeft", node("body"));
    added[0]!.listener(event);
    expect(calls).toEqual({ preventDefault: 0, stopPropagation: 0 });
  });

  test("keys that belong to a control, a modifier or someone else never reach the handler", () => {
    const { doc, added } = fakeDocument();
    let handled = 0;
    watchReaderKeys(doc, () => {
      handled += 1;
      return true;
    });
    const listener = added[0]!.listener;
    listener(press("ArrowRight", node("textarea")).event);
    listener(press("Enter", node("button")).event);
    listener(press("Enter", node("input", { type: "checkbox" })).event);
    listener(press("f", node("textarea")).event);
    listener(press("f", node("button")).event);
    listener(press("ArrowRight", node("body"), { shiftKey: true }).event);
    listener(press("ArrowRight", node("body"), { defaultPrevented: true }).event);
    listener(press("ArrowDown", node("body")).event);
    expect(handled).toBe(0);
  });
});
