import DOMPurify from "dompurify";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { compileTypst, type TypstAsset } from "../typst";
import { stripPlaceholderControls } from "../../shared/typst";
import { watchReaderKeys, type ReaderShortcut } from "../page-keys";
import { TypstSource } from "./TypstSource";

type LoadAssets = (signal: AbortSignal) => Promise<readonly TypstAsset[]>;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const tag = node.tagName.toLowerCase();
  if (tag === "a") {
    node.removeAttribute("href");
    node.removeAttribute("xlink:href");
    node.removeAttribute("target");
  }
  for (const attribute of ["href", "xlink:href"]) {
    const value = node.getAttribute(attribute);
    if (
      value &&
      !value.startsWith("#") &&
      !/^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i.test(value)
    ) {
      node.removeAttribute(attribute);
    }
  }
});

function sanitizedDocument(svg: string): string {
  const sanitized = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      "foreignObject",
      "script",
      "iframe",
      "object",
      "embed",
      "audio",
      "video",
    ],
    ADD_TAGS: ["use"],
    ADD_ATTR: ["style"],
  });
  const csp =
    "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;padding:0;background:transparent}svg{max-width:100%;height:auto;display:block}body>svg{width:100%}</style></head><body>${sanitized}</body></html>`;
}

function svgAspectRatio(svg: string): string | null {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1]?.trim().split(/\s+/);
  if (!viewBox || viewBox.length !== 4) return null;
  const width = Number(viewBox[2]);
  const height = Number(viewBox[3]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return `${width} / ${height}`;
}

interface TranslationViewProps {
  typst: string;
  /** The original image files the Typst refers to; asked for only when a preview is compiled. */
  loadAssets: LoadAssets;
  streaming?: boolean;
  editingEnabled?: boolean;
  /** The shown source is an unsaved draft; once it is saved or discarded, editing ends. */
  dirty?: boolean;
  onEdit?: (typst: string) => void;
  onSave?: () => void;
  onDiscard?: () => void;
  /** Immersive reading shows only the rendered page, hiding the source/editor tools. */
  immersive?: boolean;
  /** A reading shortcut pressed inside the preview; true when it did something. */
  onShortcut?: (shortcut: ReaderShortcut) => boolean;
  /** The preview or the source body is laid out; reading position may be restored now. */
  onRendered?: () => void;
  /** A preview failed while nothing else could show the error; the reader can leave immersive mode. */
  onPreviewError?: () => void;
}

type PreviewState =
  | { status: "compiling" }
  | {
      status: "ready";
      typst: string;
      loadAssets: LoadAssets;
      html: string;
      aspectRatio: string | null;
    }
  | { status: "failed"; message: string };

export const TranslationView = memo(function TranslationView({
  typst,
  loadAssets,
  streaming = false,
  editingEnabled = false,
  dirty = false,
  onEdit,
  onSave,
  onDiscard,
  immersive = false,
  onShortcut,
  onRendered,
  onPreviewError,
}: TranslationViewProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(typst);
  const [preview, setPreview] = useState<PreviewState>({ status: "compiling" });
  const [liveOpen, setLiveOpen] = useState(true);

  // The preview document belongs to the model's output: the page only listens there for reader keys,
  // and stops when the document is replaced or the frame is gone.
  const shortcutRef = useRef(onShortcut);
  shortcutRef.current = onShortcut;
  const renderedRef = useRef(onRendered);
  renderedRef.current = onRendered;
  const previewErrorRef = useRef(onPreviewError);
  previewErrorRef.current = onPreviewError;
  const stopKeysRef = useRef<(() => void) | null>(null);
  const attachKeys = useCallback((frame: HTMLIFrameElement): void => {
    stopKeysRef.current?.();
    stopKeysRef.current = null;
    const doc = frame.contentDocument;
    if (!doc) return;
    stopKeysRef.current = watchReaderKeys(
      doc,
      (shortcut) => shortcutRef.current?.(shortcut) ?? false,
    );
    renderedRef.current?.();
  }, []);
  const frameRef = useCallback((frame: HTMLIFrameElement | null): void => {
    if (frame) return;
    stopKeysRef.current?.();
    stopKeysRef.current = null;
  }, []);

  const previewRef = useRef(preview);
  previewRef.current = preview;

  useEffect(() => {
    if (editing) return;
    setDraft(typst);
  }, [typst, editing]);

  // Before the first keystroke there is no draft; afterwards a draft that goes away (discarded, task removed) ends editing.
  useEffect(() => {
    if (!dirty) setEditing(false);
  }, [dirty]);

  const previewSource = editing ? draft : typst;
  const wantPreview = immersive ? !streaming : mode === "preview" && !editing;
  const visibleSource = editing ? draft : typst;
  const showSource =
    !immersive && (streaming || mode === "source" || preview.status === "failed");

  useEffect(() => {
    if (streaming || !wantPreview) return;
    const current = previewRef.current;
    if (
      current.status === "ready" &&
      current.typst === previewSource &&
      current.loadAssets === loadAssets
    ) {
      return;
    }
    const controller = new AbortController();
    setPreview({ status: "compiling" });
    loadAssets(controller.signal)
      .then((assets) =>
        compileTypst(
          stripPlaceholderControls(previewSource),
          assets,
          controller.signal,
        ),
      )
      .then(
        (svg) => {
          if (controller.signal.aborted) return;
          setPreview({
            status: "ready",
            typst: previewSource,
            loadAssets,
            html: sanitizedDocument(svg),
            aspectRatio: svgAspectRatio(svg),
          });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setPreview({
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    return () => controller.abort();
  }, [loadAssets, previewSource, streaming, wantPreview]);

  // Immersive mode hides the source on failure, so the reader has to bring its error view back.
  useEffect(() => {
    if (immersive && !streaming && preview.status === "failed") {
      previewErrorRef.current?.();
    }
  }, [immersive, preview.status, streaming]);

  // A source body has no iframe load event; one frame lets it lay out before the reader restores a position.
  useEffect(() => {
    if (
      streaming ||
      (wantPreview && preview.status !== "failed") ||
      (immersive && preview.status === "failed")
    ) {
      return;
    }
    const id = requestAnimationFrame(() => renderedRef.current?.());
    return () => cancelAnimationFrame(id);
  }, [immersive, preview.status, streaming, wantPreview, visibleSource, mode, editing]);
  const previewHtml = useMemo(
    () => (preview.status === "ready" ? preview.html : ""),
    [preview],
  );

  return (
    <div className={streaming ? "translation-body streaming" : "translation-body"}>
      {!streaming && !immersive && (
        <div className="typst-toolbar">
          <div className="typst-view-toggle" role="group">
            <button
              type="button"
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
            >
              {t.translation.preview}
            </button>
            <button
              type="button"
              aria-pressed={mode === "source"}
              onClick={() => setMode("source")}
            >
              {t.translation.source}
            </button>
          </div>
          {editingEnabled && !editing && (
            <button
              type="button"
              onClick={() => {
                setDraft(typst);
                setEditing(true);
                setMode("source");
              }}
            >
              {t.translation.editSource}
            </button>
          )}
          {editing && (
            <div className="inline-actions">
              <button
                type="button"
                className="primary"
                disabled={!dirty}
                onClick={() => onSave?.()}
              >
                {t.translation.saveSource}
              </button>
              <button
                type="button"
                onClick={() => (dirty ? onDiscard?.() : setEditing(false))}
              >
                {t.translation.discardSource}
              </button>
            </div>
          )}
        </div>
      )}

      {editing && !immersive ? (
        <textarea
          className="typst-editor"
          aria-label={t.translation.sourceLabel}
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            onEdit?.(event.target.value);
          }}
        />
      ) : streaming ? (
        <details
          className="live-source"
          open
          onToggle={(event) => setLiveOpen(event.currentTarget.open)}
        >
          <summary>{t.translation.liveSource}</summary>
          {liveOpen && <TypstSource source={typst} label={t.translation.sourceLabel} />}
        </details>
      ) : showSource ? (
        <TypstSource source={visibleSource} label={t.translation.sourceLabel} />
      ) : null}

      {!streaming && wantPreview && preview.status === "compiling" && (
        <p className="muted">{t.translation.compiling}</p>
      )}
      {!streaming && preview.status === "failed" && (
        <div className="inline-error" role="alert">
          <p>{t.translation.compileFailed}</p>
          <pre className="typst-source">{preview.message}</pre>
        </div>
      )}
      {!streaming && wantPreview && preview.status === "ready" && (
        <div
          className="typst-preview"
          style={
            preview.aspectRatio
              ? { aspectRatio: preview.aspectRatio }
              : undefined
          }
        >
          <iframe
            ref={frameRef}
            title={t.translation.previewLabel}
            aria-label={t.translation.previewLabel}
            sandbox="allow-same-origin"
            srcDoc={previewHtml}
            onLoad={(event) => attachKeys(event.currentTarget)}
          />
        </div>
      )}
    </div>
  );
});
