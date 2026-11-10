// Fits the stock PDF.js toolbar to a pane that can be far narrower than the viewer expects, and to touch
// targets, without editing the vendored viewer: one adopted stylesheet and, in narrow panes, a native
// <details> that takes over existing toolbar subtrees (the nodes move, so PDF.js keeps its listeners).
//
// The viewer page forbids inline <style> (style-src 'self'), so the sheet is adopted, not injected as a node.

const ICON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E" +
  "%3Cpath d='M2 4.3h4v1.4H2zM10 4.3h4v1.4h-4zM2 10.3h7v1.4H2zM13 10.3h1v1.4h-1z'/%3E" +
  "%3Ccircle cx='8' cy='5' r='1.8'/%3E%3Ccircle cx='11' cy='11' r='1.8'/%3E%3C/svg%3E\")";

const STYLE = `
@media (max-width: 690px) {
  #mainContainer { min-width: 0; }
}
html[data-toolbar-density="touch"] { --toolbar-vertical-padding: 0px; }
html[data-toolbar-density="touch"] #toolbarContainer { --menuitem-height: var(--toolbar-height); }
html[data-toolbar-density="touch"] .toolbarField,
html[data-toolbar-density="touch"] .dropdownToolbarButton,
html[data-toolbar-density="touch"] .dropdownToolbarButton > select {
  box-sizing: border-box;
  height: var(--toolbar-height);
  margin: 0;
}
html[data-toolbar-density="touch"] .toolbarField { min-width: 56px; }
html.lumo-pages-hidden #numPages { display: none; }

/* Immersive reading: only the pages, still scrollable, with no browser-like chrome. */
html.lumo-immersive #toolbarContainer,
html.lumo-immersive #secondaryToolbar,
html.lumo-immersive #sidebarContainer,
html.lumo-immersive #loadingBar,
html.lumo-immersive #findbar,
html.lumo-immersive .editorParamsToolbar { display: none !important; }
html.lumo-immersive #mainContainer { min-width: 0; }
html.lumo-immersive #viewerContainer { inset-block-start: 0; scrollbar-width: none; }
html.lumo-immersive #viewerContainer::-webkit-scrollbar { display: none; }

#lumo-pdf-tools { display: flex; flex: none; height: 100%; aspect-ratio: 1; }
#lumo-pdf-tools[hidden] { display: none; }
#lumo-pdf-tools > summary { list-style: none; cursor: pointer; }
#lumo-pdf-tools > summary::-webkit-details-marker { display: none; }
#lumo-pdf-tools > summary::before { -webkit-mask-image: ${ICON}; mask-image: ${ICON}; }
#lumo-pdf-tools[open] > summary { background-color: var(--button-hover-color); }
.lumo-pdf-tools-panel {
  position: absolute;
  inset-block-start: 100%;
  inset-inline-end: 8px;
  z-index: 40000;
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  width: max-content;
  min-width: min(260px, calc(100vw - 16px));
  max-width: calc(100vw - 16px);
  padding: 6px;
  border-radius: 4px;
  background-color: var(--toolbar-bg-color);
  box-shadow: 0 1px 5px var(--doorhanger-border-color), 0 0 0 1px var(--doorhanger-border-color);
}
.lumo-pdf-tools-panel .toolbarHorizontalGroup,
.lumo-pdf-tools-panel .toolbarButtonWithContainer { height: var(--toolbar-height); }
.lumo-pdf-tools-panel .toolbarButtonWithContainer { position: static; }
.lumo-pdf-tools-panel :is(#findbar, .editorParamsToolbar) {
  inset-inline: 0 auto;
  inset-block-start: calc(100% + 6px);
  min-width: 0;
  max-width: 100%;
}
.lumo-pdf-tools-panel :is(#findbar, .editorParamsToolbar)::before,
.lumo-pdf-tools-panel :is(#findbar, .editorParamsToolbar)::after { display: none; }
`;

/** Pane widths (CSS px of the viewer) at which more of the toolbar moves into the tools menu. */
const MENU_WIDTH = 690;
const COMPACT_WIDTH = 360;
const TINY_WIDTH = 260;

interface Group {
  node: Element | null;
  /** Remembers the original position while the node sits in the menu. */
  marker: Comment;
  /** The first width level (1 = menu, 2 = compact) at which the node moves. */
  level: number;
  moved: boolean;
}

/** Adapts the toolbar of the viewer in `win`; the returned function undoes everything. */
export function adaptPdfToolbar(win: Window, toolsLabel: string): () => void {
  // Constructors of the viewer's own realm: a sheet or observer from this page's realm would not belong to its document.
  const view = win as Window & typeof globalThis;
  const doc = win.document;
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(STYLE);
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];

  const details = doc.createElement("details");
  details.id = "lumo-pdf-tools";
  details.hidden = true;
  const summary = doc.createElement("summary");
  summary.className = "toolbarButton";
  summary.setAttribute("aria-label", toolsLabel);
  summary.title = toolsLabel;
  const panel = doc.createElement("div");
  panel.className = "lumo-pdf-tools-panel";
  details.append(summary, panel);

  const groups: Group[] = [
    { node: doc.getElementById("editorModeButtons"), level: 1 },
    { node: doc.getElementById("toolbarViewerMiddle"), level: 2 },
    { node: doc.getElementById("viewFindButton")?.closest(".toolbarButtonWithContainer") ?? null, level: 2 },
  ].map((group) => ({ ...group, marker: doc.createComment("lumo-pdf-tools"), moved: false }));

  // Tools that PDF.js hides for this document stay hidden in the menu; with none left, there is no empty menu.
  const hasTools = (): boolean =>
    Array.from(panel.querySelectorAll("button, input, select")).some((control) => {
      const hidden = control.closest("[hidden]");
      return !hidden || !panel.contains(hidden);
    });

  const syncMenu = (): void => {
    details.hidden = !groups.some((group) => group.moved) || !hasTools();
    if (details.hidden) details.open = false;
  };

  const queries = [MENU_WIDTH, COMPACT_WIDTH, TINY_WIDTH].map((width) =>
    win.matchMedia(`(max-width: ${width}px)`),
  );
  const sync = (): void => {
    const level = queries.filter((query) => query.matches).length;
    doc.documentElement.classList.toggle("lumo-pages-hidden", level >= 3);
    for (const group of groups) {
      const node = group.node;
      if (!node) continue;
      const wanted = level >= group.level;
      if (wanted && !group.moved) {
        node.before(group.marker);
        panel.append(node);
        if (!details.isConnected) group.marker.after(details);
        group.moved = true;
      } else if (!wanted && group.moved) {
        group.marker.replaceWith(node);
        group.moved = false;
      }
    }
    if (!groups.some((group) => group.moved)) details.remove();
    syncMenu();
  };

  const observer = new view.MutationObserver(syncMenu);
  observer.observe(panel, { subtree: true, attributes: true, attributeFilter: ["hidden"] });

  const close = (focus: boolean): void => {
    details.open = false;
    if (focus) summary.focus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // A tool popup that is open closes first; PDF.js handles that Escape itself.
    if (panel.querySelector('[aria-expanded="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };
  const onPointerDown = (event: Event): void => {
    if (details.open && !details.contains(event.target as Node)) close(false);
  };
  details.addEventListener("keydown", onKeyDown);
  doc.addEventListener("pointerdown", onPointerDown, true);
  for (const query of queries) query.addEventListener("change", sync);
  sync();

  return () => {
    for (const query of queries) query.removeEventListener("change", sync);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    details.removeEventListener("keydown", onKeyDown);
    observer.disconnect();
    for (const group of groups) {
      if (group.node && group.moved) group.marker.replaceWith(group.node);
      group.moved = false;
    }
    details.remove();
    doc.documentElement.classList.remove("lumo-pages-hidden");
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
  };
}
