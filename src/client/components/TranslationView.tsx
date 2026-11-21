import DOMPurify from "dompurify";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { compileTypst, type TypstAsset } from "../typst";
import { stripPlaceholderControls } from "../../shared/typst";
import { translationPreviewWidth, type Size } from "../translation-zoom";
import type { TranslationZoom } from "../../shared/contracts";
import { previewPaint } from "../reading-theme";
import { drawPreview, loadSvgImage, rasterSize } from "../typst-raster";
import { useTheme } from "../theme";
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

function sanitizedSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
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
}

/** Redraws after the preview box stops resizing; meanwhile the old bitmap is stretched. */
const RESIZE_REDRAW_MS = 120;

/** The rendered page's size in Typst points, from the SVG's viewBox. */
function svgPageSize(svg: string): Size | null {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1]?.trim().split(/\s+/);
  if (!viewBox || viewBox.length !== 4) return null;
  const width = Number(viewBox[2]);
  const height = Number(viewBox[3]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

export interface TranslationZoomFrame {
  value: TranslationZoom;
  /** The scrolling pane's content box in CSS pixels. */
  viewport: Size;
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
  /** The preview or the source body is laid out; reading position may be restored now. */
  onRendered?: () => void;
  /** A preview failed while nothing else could show the error; the reader can leave immersive mode. */
  onPreviewError?: () => void;
  /** Sizes the preview page by a zoom; without one the page fills the pane's width. */
  zoom?: TranslationZoomFrame;
}

type PreviewState =
  | { status: "compiling" }
  | {
      status: "ready";
      typst: string;
      loadAssets: LoadAssets;
      /** The sanitized page decoded as an image, drawn into the preview canvas. */
      image: HTMLImageElement;
      pageSize: Size | null;
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
  onRendered,
  onPreviewError,
  zoom,
}: TranslationViewProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(typst);
  const [preview, setPreview] = useState<PreviewState>({ status: "compiling" });
  const [liveOpen, setLiveOpen] = useState(true);

  const renderedRef = useRef(onRendered);
  renderedRef.current = onRendered;
  const previewErrorRef = useRef(onPreviewError);
  previewErrorRef.current = onPreviewError;
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
      .then(async (svg) => {
        const sanitized = sanitizedSvg(svg);
        const image = await loadSvgImage(sanitized);
        const pageSize =
          svgPageSize(svg) ??
          (image.naturalWidth > 0 && image.naturalHeight > 0
            ? { width: image.naturalWidth, height: image.naturalHeight }
            : null);
        return { pageSize, image };
      })
      .then(
        ({ pageSize, image }) => {
          if (controller.signal.aborted) return;
          setPreview({
            status: "ready",
            typst: previewSource,
            loadAssets,
            image,
            pageSize,
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

  // A source body is not drawn; one frame lets it lay out before the reader restores a position.
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
  const { theme } = useTheme();
  const paint = useMemo(() => previewPaint(theme), [theme]);
  const shownImage = !streaming && wantPreview && preview.status === "ready" ? preview.image : null;

  // The page is drawn once per decoded image, theme, size and pixel ratio; scrolling only moves the bitmap.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!shownImage || !canvas) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame: number | null = null;
    let resolution: MediaQueryList | null = null;
    let drawn = false;
    let reported = false;
    const draw = (): void => {
      const box = canvas.getBoundingClientRect();
      // A hidden pane has no size; the observer draws once it is shown.
      if (box.width <= 0 || box.height <= 0) return;
      const size = rasterSize(box, window.devicePixelRatio || 1);
      if (drawn && canvas.width === size.width && canvas.height === size.height) return;
      drawPreview(canvas, shownImage, paint, size);
      drawn = true;
      if (!reported) {
        reported = true;
        frame = requestAnimationFrame(() => renderedRef.current?.());
      }
    };
    const onResolution = (): void => {
      watchResolution();
      drawn = false;
      draw();
    };
    const watchResolution = (): void => {
      resolution?.removeEventListener("change", onResolution);
      resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      resolution.addEventListener("change", onResolution);
    };
    draw();
    watchResolution();
    const observer = new ResizeObserver(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(draw, RESIZE_REDRAW_MS);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      resolution?.removeEventListener("change", onResolution);
      if (timer !== null) clearTimeout(timer);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [shownImage, paint]);
  const zoomedWidth =
    zoom && preview.status === "ready" && preview.pageSize
      ? translationPreviewWidth(zoom.value, preview.pageSize, zoom.viewport)
      : null;

  return (
    <div className={streaming ? "translation-body streaming" : "translation-body"}>
      {!streaming && !immersive && (
        <div className="typst-toolbar">
          <div className="segmented" role="group">
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
          className={zoomedWidth === null ? "typst-preview" : "typst-preview zoomed"}
          style={
            preview.pageSize
              ? {
                  aspectRatio: `${preview.pageSize.width} / ${preview.pageSize.height}`,
                  ...(zoomedWidth === null ? {} : { width: `${zoomedWidth}px` }),
                }
              : undefined
          }
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={t.translation.previewLabel}
            style={paint.filter ? { filter: paint.filter } : undefined}
          />
        </div>
      )}
    </div>
  );
});
