// Left and right arrow keys turn the page. Plain DOM, no imports: the sandboxed EPUB viewer bundles this file too.

export type PageStep = "next" | "prev";

/** The page a plain left or right key press turns to; any modifier or an IME composition leaves the key alone. */
export function pageStep(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing">,
): PageStep | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) {
    return null;
  }
  if (event.key === "ArrowRight") return "next";
  if (event.key === "ArrowLeft") return "prev";
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

/**
 * Listens in the capture phase of `doc` for a plain left or right key press that no control needs.
 * `handle` returns true when it took the page turn; the key is then consumed, so nothing later
 * in the page (the PDF viewer's own key handler, scrolling) acts on it a second time.
 */
export function watchPageKeys(
  doc: Document,
  handle: (direction: PageStep, event: KeyboardEvent) => boolean,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const direction = pageStep(event);
    if (!direction || ownsArrowKeys(event.target)) return;
    if (!handle(direction, event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  doc.addEventListener("keydown", onKeyDown, true);
  return () => doc.removeEventListener("keydown", onKeyDown, true);
}
