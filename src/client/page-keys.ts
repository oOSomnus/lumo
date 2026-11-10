// Reader keyboard shortcuts. Plain DOM, no imports: the sandboxed EPUB viewer bundles this file too.

export type PageStep = "next" | "prev";

export type LayoutPreset = 1 | 2 | 3 | 4 | 5;

export type ReaderShortcut =
  | { type: "step"; direction: PageStep }
  | { type: "translate" }
  | { type: "layout"; preset: LayoutPreset }
  | { type: "toggle-immersive" }
  | { type: "exit-immersive" };

type ShortcutEvent = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "altKey"
  | "ctrlKey"
  | "metaKey"
  | "shiftKey"
  | "isComposing"
  | "repeat"
>;

/** The reading command a key press asks for; null leaves the key to the page. */
export function readerShortcut(event: ShortcutEvent): ReaderShortcut | null {
  if (event.isComposing || event.altKey) return null;
  const primary = event.ctrlKey || event.metaKey;
  if (event.key === "Escape" && !primary && !event.shiftKey) {
    return { type: "exit-immersive" };
  }
  if (
    event.key.toLowerCase() === "f" &&
    !primary &&
    !event.shiftKey &&
    !event.repeat
  ) {
    return { type: "toggle-immersive" };
  }
  if (primary) {
    const digit = /^Digit([1-5])$/.exec(event.code)?.[1];
    if (!digit || event.repeat) return null;
    return { type: "layout", preset: Number(digit) as LayoutPreset };
  }
  if (event.key === "Enter") {
    if (event.repeat || event.shiftKey) return null;
    return { type: "translate" };
  }
  if (event.shiftKey) return null;
  if (event.key === "ArrowRight") return { type: "step", direction: "next" };
  if (event.key === "ArrowLeft") return { type: "step", direction: "prev" };
  return null;
}

// Widgets whose own arrow-key behaviour the page must not take over.
const ARROW_ROLES: Record<string, true> = {
  textbox: true,
  searchbox: true,
  combobox: true,
  listbox: true,
  slider: true,
  spinbutton: true,
  separator: true,
  tree: true,
  treegrid: true,
  grid: true,
  menu: true,
  menubar: true,
  tablist: true,
  radiogroup: true,
  scrollbar: true,
};

// Inputs that have no use for arrow keys; a ticked checkbox must not stop the reader from turning the page.
const PLAIN_INPUTS: Record<string, true> = {
  checkbox: true,
  button: true,
  submit: true,
  reset: true,
  image: true,
  file: true,
  color: true,
  hidden: true,
};

// Roles that already turn Enter into their own action.
const ENTER_ROLES: Record<string, true> = {
  ...ARROW_ROLES,
  button: true,
  checkbox: true,
  link: true,
  menuitem: true,
  menuitemcheckbox: true,
  menuitemradio: true,
  option: true,
  radio: true,
  switch: true,
  tab: true,
};

const ENTER_ELEMENTS: Record<string, true> = {
  a: true,
  button: true,
  input: true,
  select: true,
  summary: true,
  textarea: true,
};

interface NodeLike {
  localName?: string;
  type?: string;
  isContentEditable?: boolean;
  parentElement?: NodeLike | null;
  getAttribute?(name: string): string | null;
}

/**
 * True when the focused element, or one of its ancestors, needs the arrow keys itself: text entry,
 * selects, sliders, trees, tabs, separators. Reads properties only, so elements of an iframe's
 * own realm qualify as well; `instanceof Element` would not.
 */
export function ownsArrowKeys(target: EventTarget | null): boolean {
  for (
    let node = target as NodeLike | null;
    node && typeof node.getAttribute === "function";
    node = node.parentElement ?? null
  ) {
    if (node.isContentEditable) return true;
    if (node.localName === "textarea" || node.localName === "select") return true;
    if (node.localName === "input" && PLAIN_INPUTS[node.type ?? "text"] !== true) return true;
    const roles = node.getAttribute("role")?.split(/\s+/);
    if (roles?.some((role) => ARROW_ROLES[role] === true)) return true;
  }
  return false;
}

/** True when the focused control turns Enter into its own action instead of translating the page. */
export function ownsEnterKeys(target: EventTarget | null): boolean {
  for (
    let node = target as NodeLike | null;
    node && typeof node.getAttribute === "function";
    node = node.parentElement ?? null
  ) {
    if (node.isContentEditable) return true;
    if (node.localName && ENTER_ELEMENTS[node.localName] === true) return true;
    const roles = node.getAttribute("role")?.split(/\s+/);
    if (roles?.some((role) => ENTER_ROLES[role] === true)) return true;
  }
  return false;
}

/**
 * Listens in the capture phase of `doc` for a reader shortcut that no control needs.
 * `handle` returns true when it took the shortcut; the key is then consumed, so nothing later
 * in the page (the PDF viewer's own key handler, scrolling) acts on it a second time.
 */
export function watchReaderKeys(
  doc: Document,
  handle: (shortcut: ReaderShortcut, event: KeyboardEvent) => boolean,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const shortcut = readerShortcut(event);
    if (!shortcut) return;
    if (shortcut.type === "step" && ownsArrowKeys(event.target)) return;
    if (shortcut.type === "translate" && ownsEnterKeys(event.target)) return;
    if (shortcut.type === "toggle-immersive" && ownsEnterKeys(event.target)) return;
    if (!handle(shortcut, event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  doc.addEventListener("keydown", onKeyDown, true);
  return () => doc.removeEventListener("keydown", onKeyDown, true);
}
