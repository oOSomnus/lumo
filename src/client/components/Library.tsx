import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentRecord } from "../../shared/contracts";
import { errorText, formatDateTime, useI18n, type UiError } from "../i18n";
import { renderDocumentCover } from "../pdf";

export interface LibraryProps {
  documents: DocumentRecord[];
  active: boolean;
  currentDocumentId: string | null;
  currentPage: number;
  error: UiError | null;
  onOpen: (document: DocumentRecord) => void;
  onDownload: (document: DocumentRecord) => void;
  onDelete: (document: DocumentRecord) => void;
  onOpenPdf: () => void;
  onDropPdf: (file: File) => void;
}

function BookCover({
  url,
  failed,
  unavailable,
}: {
  url: string | undefined;
  failed: boolean;
  unavailable: string;
}) {
  if (url) {
    return (
      <span className="book-cover">
        <img src={url} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className="book-cover">
      <span
        className={failed ? "book-cover-note" : "book-cover-note pending"}
        aria-hidden={!failed}
      >
        {failed ? unavailable : ""}
      </span>
    </span>
  );
}

export function Library({
  documents,
  active,
  currentDocumentId,
  currentPage,
  error,
  onOpen,
  onDownload,
  onDelete,
  onOpenPdf,
  onDropPdf,
}: LibraryProps) {
  const { locale, t } = useI18n();
  const scrollRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const coverUrlsRef = useRef(new Map<string, string>());
  const failedCoversRef = useRef(new Set<string>());
  const visibleCoversRef = useRef(new Set<string>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const runningRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const mountedRef = useRef(true);
  const wasActiveRef = useRef(active);
  const [, setCoverVersion] = useState(0);

  const startNextCover = useCallback(() => {
    if (!mountedRef.current || !activeRef.current || runningRef.current) return;
    let next: string | null = null;
    for (const id of visibleCoversRef.current) {
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
    renderDocumentCover(documentId, controller.signal)
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
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const documentId = (entry.target as HTMLElement).dataset.coverId;
          if (!documentId) continue;
          if (entry.isIntersecting) {
            visibleCoversRef.current.add(documentId);
          } else {
            visibleCoversRef.current.delete(documentId);
            controllersRef.current.get(documentId)?.abort();
          }
        }
        startNextCover();
      },
      { root, rootMargin: "200px" },
    );
    for (const card of root.querySelectorAll<HTMLElement>("[data-cover-id]")) {
      observer.observe(card);
    }
    return () => observer.disconnect();
  }, [documents, startNextCover]);

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
    for (const id of visibleCoversRef.current) {
      if (!ids.has(id)) visibleCoversRef.current.delete(id);
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

  return (
    <main
      ref={scrollRef}
      className="library-screen"
      aria-labelledby="library-title"
      inert={!active}
      aria-hidden={!active}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files?.[0];
        if (file) onDropPdf(file);
      }}
    >
      <div className="library-content">
        <h1 id="library-title" ref={headingRef} tabIndex={-1}>
          {t.library.title}
        </h1>
        {error && (
          <p className="field-error" role="alert">
            {errorText(error, locale)}
          </p>
        )}
        {documents.length === 0 ? (
          <div className="library-empty">
            <p>{t.library.empty}</p>
            <button type="button" className="primary" onClick={onOpenPdf}>
              {t.common.openPdf}
            </button>
          </div>
        ) : (
          <ul className="book-grid">
            {documents.map((document) => {
              const coverUrl = coverUrlsRef.current.get(document.id);
              const coverFailed = failedCoversRef.current.has(document.id);
              const shownPage =
                document.id === currentDocumentId
                  ? currentPage
                  : document.currentPage;
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
                      url={coverUrl}
                      failed={coverFailed}
                      unavailable={t.library.coverUnavailable}
                    />
                    <span className="book-title">{document.name}</span>
                  </button>
                  <p className="book-meta">
                    {t.common.pageOf(shownPage, document.pageCount)}
                  </p>
                  <p className="book-meta muted">
                    {t.library.recentlyRead(
                      formatDateTime(locale, document.lastOpenedAt),
                    )}
                  </p>
                  <div className="book-actions">
                    <button type="button" onClick={() => onDownload(document)}>
                      {t.common.download}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => onDelete(document)}
                    >
                      {t.common.delete}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
