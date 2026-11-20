import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentRecord } from "../../shared/contracts";
import { errorText, formatDateTime, useI18n, type UiError } from "../i18n";
import {
  BookOpenIcon,
  DownloadIcon,
  FilePlusIcon,
  GridIcon,
  ListIcon,
  SearchIcon,
  TrashIcon,
} from "../icons";
import {
  arrangeDocuments,
  LIBRARY_SORTS,
  loadLibraryPrefs,
  readingProgress,
  relativeTime,
  saveLibraryPrefs,
  type LibraryPrefs,
  type LibrarySort,
} from "../library-view";
import { renderDocumentCover } from "../pdf";

export interface LibraryProps {
  documents: DocumentRecord[];
  active: boolean;
  currentDocumentId: string | null;
  currentPage: number;
  error: UiError | null;
  /** A book (or a file not yet imported) is open behind the library. */
  canReturn: boolean;
  onReturn: () => void;
  onOpen: (document: DocumentRecord) => void;
  onDownload: (document: DocumentRecord) => void;
  onDelete: (document: DocumentRecord) => void;
  onOpenPdf: () => void;
}

/** A generated cover for a book without one: a quiet colour from its name, framed, with the title set in serif. */
function renderEpubCover(name: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 640;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("canvas unavailable"));
  let hue = 0;
  for (let index = 0; index < name.length; index += 1) {
    hue = (hue * 31 + name.charCodeAt(index)) % 360;
  }
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, `hsl(${hue} 28% 32%)`);
  gradient.addColorStop(1, `hsl(${(hue + 24) % 360} 32% 20%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgba(255,255,255,0.28)";
  context.lineWidth = 2;
  context.strokeRect(28, 28, canvas.width - 56, canvas.height - 56);
  context.fillStyle = "rgba(255,255,255,0.94)";
  context.textAlign = "center";
  context.textBaseline = "top";
  context.font = "600 40px Georgia, 'Noto Serif CJK SC', 'Songti SC', serif";
  const title = name.replace(/\.epub$/i, "");
  const maxWidth = canvas.width - 120;
  const lines: string[] = [];
  let line = "";
  // Break between words, or between characters for scripts written without spaces.
  for (const part of title.split(/(?<=\s)|(?=[\u3000-\u9fff])/u)) {
    const candidate = line + part;
    if (context.measureText(candidate.trim()).width > maxWidth && line) {
      lines.push(line.trim());
      line = part;
      if (lines.length === 6) break;
    } else {
      line = candidate;
    }
  }
  if (lines.length < 6 && line.trim()) lines.push(line.trim());
  const top = Math.max(120, 300 - lines.length * 26);
  lines.forEach((text, index) => context.fillText(text, canvas.width / 2, top + index * 54));
  context.fillStyle = "rgba(255,255,255,0.55)";
  context.fillRect(canvas.width / 2 - 24, top - 36, 48, 2);
  context.font = "600 20px system-ui, sans-serif";
  context.fillText("E P U B", canvas.width / 2, canvas.height - 92);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("cover encoding failed"))),
      "image/png",
    ),
  );
}

function BookCover({
  url,
  failed,
  unavailable,
  format,
  progress,
}: {
  url: string | undefined;
  failed: boolean;
  unavailable: string;
  format?: DocumentRecord["format"];
  progress?: number;
}) {
  return (
    <span className="book-cover">
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <span
          className={failed ? "book-cover-note" : "book-cover-note pending"}
          aria-hidden={!failed}
        >
          {failed ? unavailable : ""}
        </span>
      )}
      {format && <span className="badge format" aria-hidden="true">{format}</span>}
      {progress !== undefined && progress > 0 && (
        <span className="progress" aria-hidden="true">
          <span style={{ width: `${progress * 100}%` }} />
        </span>
      )}
    </span>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <span className="progress" aria-hidden="true">
      <span style={{ width: `${value * 100}%` }} />
    </span>
  );
}

export function Library({
  documents,
  active,
  currentDocumentId,
  currentPage,
  error,
  canReturn,
  onReturn,
  onOpen,
  onDownload,
  onDelete,
  onOpenPdf,
}: LibraryProps) {
  const { locale, t } = useI18n();
  const scrollRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const coverUrlsRef = useRef(new Map<string, string>());
  const failedCoversRef = useRef(new Set<string>());
  /** How many elements showing each cover are on screen; a cover renders while any is. */
  const visibleCoversRef = useRef(new Map<string, number>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const runningRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const mountedRef = useRef(true);
  const wasActiveRef = useRef(active);
  const [, setCoverVersion] = useState(0);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState<LibraryPrefs>(loadLibraryPrefs);

  const changePrefs = (change: Partial<LibraryPrefs>) => {
    setPrefs((previous) => {
      const next = { ...previous, ...change };
      saveLibraryPrefs(next);
      return next;
    });
  };

  const shown = useMemo(
    () => arrangeDocuments(documents, query, prefs.sort, locale),
    [documents, query, prefs.sort, locale],
  );
  const continueDocument = useMemo(() => {
    if (canReturn || query.trim() || documents.length === 0) return null;
    return documents.reduce((latest, document) =>
      document.lastOpenedAt > latest.lastOpenedAt ? document : latest,
    );
  }, [canReturn, documents, query]);

  const startNextCover = useCallback(() => {
    if (!mountedRef.current || !activeRef.current || runningRef.current) return;
    let next: string | null = null;
    for (const id of visibleCoversRef.current.keys()) {
      if (!coverUrlsRef.current.has(id) && !failedCoversRef.current.has(id)) {
        next = id;
        break;
      }
    }
    if (next === null) return;
    const documentId = next;
    runningRef.current = documentId;
    const controller = new AbortController();
    controllersRef.current.set(documentId, controller);
    const document = documentsRef.current.find((item) => item.id === documentId);
    const render =
      document?.format === "epub"
        ? renderEpubCover(document.name)
        : renderDocumentCover(documentId, controller.signal);
    render
      .then(
        (blob) => {
          if (!mountedRef.current || controller.signal.aborted) return;
          coverUrlsRef.current.set(documentId, URL.createObjectURL(blob));
          setCoverVersion((version) => version + 1);
        },
        () => {
          if (!mountedRef.current || controller.signal.aborted) return;
          failedCoversRef.current.add(documentId);
          setCoverVersion((version) => version + 1);
        },
      )
      .finally(() => {
        controllersRef.current.delete(documentId);
        if (runningRef.current === documentId) runningRef.current = null;
        startNextCover();
      });
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (active) {
      startNextCover();
      return;
    }
    for (const controller of controllersRef.current.values()) controller.abort();
  }, [active, startNextCover]);

  useEffect(() => {
    if (active && !wasActiveRef.current) headingRef.current?.focus();
    wasActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onScreen = new Set<Element>();
    const visible = visibleCoversRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const documentId = (entry.target as HTMLElement).dataset.coverId;
          if (!documentId) continue;
          if (entry.isIntersecting && !onScreen.has(entry.target)) {
            onScreen.add(entry.target);
            visible.set(documentId, (visible.get(documentId) ?? 0) + 1);
          } else if (!entry.isIntersecting && onScreen.delete(entry.target)) {
            const remaining = (visible.get(documentId) ?? 1) - 1;
            if (remaining > 0) {
              visible.set(documentId, remaining);
            } else {
              visible.delete(documentId);
              controllersRef.current.get(documentId)?.abort();
            }
          }
        }
        startNextCover();
      },
      { root, rootMargin: "200px" },
    );
    for (const card of root.querySelectorAll<HTMLElement>("[data-cover-id]")) {
      observer.observe(card);
    }
    return () => {
      observer.disconnect();
      visible.clear();
    };
  }, [shown, prefs.view, continueDocument, startNextCover]);

  useEffect(() => {
    const ids = new Set(documents.map((document) => document.id));
    for (const [id, url] of coverUrlsRef.current) {
      if (ids.has(id)) continue;
      URL.revokeObjectURL(url);
      coverUrlsRef.current.delete(id);
      controllersRef.current.get(id)?.abort();
    }
    for (const [id, controller] of controllersRef.current) {
      if (!ids.has(id)) controller.abort();
    }
    for (const id of failedCoversRef.current) {
      if (!ids.has(id)) failedCoversRef.current.delete(id);
    }
  }, [documents]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
      for (const url of coverUrlsRef.current.values()) URL.revokeObjectURL(url);
      coverUrlsRef.current.clear();
    };
  }, []);

  const now = Date.now();
  const pageOf = (document: DocumentRecord) => {
    const page = document.id === currentDocumentId ? currentPage : document.currentPage;
    return {
      page,
      label:
        document.format === "epub"
          ? t.common.sectionOf(page, document.pageCount)
          : t.common.pageOf(page, document.pageCount),
      progress: readingProgress(page, document.pageCount),
    };
  };
  const lastRead = (document: DocumentRecord) => ({
    text: t.library.lastRead(relativeTime(locale, document.lastOpenedAt, now)),
    title: formatDateTime(locale, document.lastOpenedAt),
  });
  const actions = (document: DocumentRecord) => (
    <div className="book-actions">
      <button
        type="button"
        className="icon-button"
        aria-label={t.common.download}
        title={t.common.download}
        onClick={() => onDownload(document)}
      >
        <DownloadIcon size={16} />
      </button>
      <button
        type="button"
        className="icon-button danger"
        aria-label={t.common.delete}
        title={t.common.delete}
        onClick={() => onDelete(document)}
      >
        <TrashIcon size={16} />
      </button>
    </div>
  );

  return (
    <main
      ref={scrollRef}
      className="library-screen"
      aria-labelledby="library-title"
      inert={!active}
      aria-hidden={!active}
    >
      <div className="library-content">
        <header className="page-header">
          <div>
            <h1 id="library-title" ref={headingRef} tabIndex={-1}>
              {t.library.title}
            </h1>
            {documents.length > 0 && (
              <p className="page-subtitle">{t.library.count(documents.length)}</p>
            )}
          </div>
          {canReturn && (
            <div className="page-header-actions">
              <button type="button" className="primary" onClick={onReturn}>
                <BookOpenIcon size={16} />
                {t.library.returnToReader}
              </button>
            </div>
          )}
        </header>
        {error && (
          <p className="alert error" role="alert">
            {errorText(error, locale)}
          </p>
        )}
        {documents.length === 0 ? (
          <div className="library-empty">
            <span className="empty-illustration" aria-hidden="true">
              <BookOpenIcon size={36} />
            </span>
            <h2>{t.library.emptyTitle}</h2>
            <p>{t.library.emptyBody}</p>
            <button type="button" className="primary" onClick={onOpenPdf}>
              <FilePlusIcon size={16} />
              {t.common.openPdf}
            </button>
            <p className="muted">{t.library.emptyDrop}</p>
          </div>
        ) : (
          <>
            {continueDocument && (
              <section aria-labelledby="library-continue">
                <h2 className="section-label" id="library-continue">
                  {t.library.continueReading}
                </h2>
                <div className="continue-card card" data-cover-id={continueDocument.id}>
                  <BookCover
                    url={coverUrlsRef.current.get(continueDocument.id)}
                    failed={failedCoversRef.current.has(continueDocument.id)}
                    unavailable={t.library.coverUnavailable}
                  />
                  <div className="continue-body">
                    <span className="continue-title" title={continueDocument.name}>
                      {continueDocument.name}
                    </span>
                    <span className="book-meta">
                      {pageOf(continueDocument).label} · {lastRead(continueDocument).text}
                    </span>
                    <ProgressBar value={pageOf(continueDocument).progress} />
                  </div>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onOpen(continueDocument)}
                  >
                    <BookOpenIcon size={16} />
                    {t.library.resume}
                  </button>
                </div>
              </section>
            )}
            <div className="library-toolbar">
              <label className="search-field">
                <SearchIcon size={16} />
                <input
                  type="search"
                  value={query}
                  aria-label={t.library.search}
                  placeholder={t.library.searchPlaceholder}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query) {
                      event.preventDefault();
                      setQuery("");
                    }
                  }}
                />
              </label>
              <label className="sort-field">
                {t.library.sort}
                <select
                  value={prefs.sort}
                  onChange={(event) => changePrefs({ sort: event.target.value as LibrarySort })}
                >
                  {LIBRARY_SORTS.map((sort) => (
                    <option key={sort} value={sort}>
                      {t.library.sorts[sort]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="segmented" role="group" aria-label={t.library.view}>
                {(["grid", "list"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    className="icon-button"
                    aria-pressed={prefs.view === view}
                    aria-label={t.library.views[view]}
                    title={t.library.views[view]}
                    onClick={() => changePrefs({ view })}
                  >
                    {view === "grid" ? <GridIcon size={16} /> : <ListIcon size={16} />}
                  </button>
                ))}
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="library-no-results" role="status">
                {t.library.noResults(query.trim())}
              </p>
            ) : prefs.view === "grid" ? (
              <ul className="book-grid">
                {shown.map((document) => {
                  const position = pageOf(document);
                  const read = lastRead(document);
                  return (
                    <li key={document.id} className="book-card" data-cover-id={document.id}>
                      <button
                        type="button"
                        className="book-open"
                        aria-label={document.name}
                        title={document.name}
                        onClick={() => onOpen(document)}
                      >
                        <BookCover
                          url={coverUrlsRef.current.get(document.id)}
                          failed={failedCoversRef.current.has(document.id)}
                          unavailable={t.library.coverUnavailable}
                          format={document.format}
                          progress={position.progress}
                        />
                        <span className="book-title">{document.name}</span>
                      </button>
                      <p className="book-meta">{position.label}</p>
                      <p className="book-meta muted" title={read.title}>
                        {read.text}
                      </p>
                      {actions(document)}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <ul className="book-list card">
                {shown.map((document) => {
                  const position = pageOf(document);
                  const read = lastRead(document);
                  return (
                    <li key={document.id} className="book-row" data-cover-id={document.id}>
                      <button
                        type="button"
                        className="book-open"
                        aria-label={document.name}
                        title={document.name}
                        onClick={() => onOpen(document)}
                      >
                        <BookCover
                          url={coverUrlsRef.current.get(document.id)}
                          failed={failedCoversRef.current.has(document.id)}
                          unavailable=""
                        />
                        <span className="book-title">{document.name}</span>
                        <span className="book-meta">{position.label}</span>
                        <span className="book-row-progress">
                          <ProgressBar value={position.progress} />
                          <span className="book-meta">
                            {t.library.progress(Math.round(position.progress * 100))}
                          </span>
                        </span>
                        <span className="book-meta" title={read.title}>
                          {read.text}
                        </span>
                      </button>
                      {actions(document)}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </main>
  );
}
