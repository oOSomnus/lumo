import { useEffect, useMemo, useState } from "react";
import type {
  DocumentRecord,
  TargetLanguage,
  TranslationLocationSummary,
} from "../shared/contracts";
import { isEpubPageUnit } from "../shared/epub";
import { apiJson } from "./api";
import { isOpenTask } from "./epub-batch";
import { toUiError, type UiError } from "./i18n";
import type { TranslationTask } from "./translation-queue";

const NO_LOCATIONS: TranslationLocationSummary[] = [];

export interface TranslatedPages {
  status: "loading" | "ready" | "error";
  error: UiError | null;
  /** Pages with a saved whole-page translation in this language. */
  savedPages: ReadonlySet<number>;
  /** `${pageNumber}/${unit}` of every saved EPUB screen page. */
  savedUnits: ReadonlySet<string>;
  /** Pages with a task a new run must leave alone: waiting, running or holding a draft. */
  issuePages: ReadonlySet<number>;
  /** The whole-page tasks of every document: PDF pages, or EPUB screen pages. */
  pageTasks: TranslationTask[];
  reload(): void;
}

/**
 * What is translated in one document and language: the saved locations read
 * from the server, joined with the pages the queue has saved since.
 */
export function useTranslatedPages(
  document: DocumentRecord,
  language: TargetLanguage,
  tasks: TranslationTask[],
): TranslatedPages {
  const isEpub = document.format === "epub";
  const pageTasks = useMemo(
    () => tasks.filter((task) => (isEpub ? isEpubPageUnit(task.unit ?? "") : !task.unit)),
    [tasks, isEpub],
  );
  const [read, setRead] = useState<{
    key: string;
    status: "loading" | "ready" | "error";
    locations: TranslationLocationSummary[];
    error: UiError | null;
  }>({ key: "", status: "loading", locations: NO_LOCATIONS, error: null });
  const [reloadToken, setReloadToken] = useState(0);
  const key = `${document.id}/${language}`;

  useEffect(() => {
    const controller = new AbortController();
    setRead((previous) =>
      previous.key === key
        ? previous
        : { key, status: "loading", locations: NO_LOCATIONS, error: null },
    );
    void apiJson<{ locations: TranslationLocationSummary[] }>(
      `/api/documents/${document.id}/translation-locations?targetLanguage=${language}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setRead({ key, status: "ready", locations: result.locations, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRead({ key, status: "error", locations: NO_LOCATIONS, error: toUiError(error) });
      });
    return () => controller.abort();
  }, [document.id, language, key, reloadToken]);

  const active =
    read.key === key ? read : { status: "loading" as const, locations: NO_LOCATIONS, error: null };

  // A PDF page or an EPUB screen page counts as translated; an EPUB selection never does.
  const { savedPages, savedUnits } = useMemo(() => {
    const pages = new Set<number>();
    const units = new Set<string>();
    const add = (pageNumber: number, unit: string): void => {
      pages.add(pageNumber);
      if (unit) units.add(`${pageNumber}/${unit}`);
    };
    for (const location of active.locations) {
      if (isEpub ? isEpubPageUnit(location.unit) : location.unit === "") {
        add(location.pageNumber, location.unit);
      }
    }
    for (const task of pageTasks) {
      if (
        task.documentId === document.id &&
        task.targetLanguage === language &&
        task.stage === "saved"
      ) {
        add(task.pageNumber, task.unit ?? "");
      }
    }
    return { savedPages: pages, savedUnits: units };
  }, [active.locations, pageTasks, document.id, language, isEpub]);

  const issuePages = useMemo(() => {
    const pages = new Set<number>();
    for (const task of pageTasks) {
      if (task.documentId === document.id && task.targetLanguage === language && isOpenTask(task)) {
        pages.add(task.pageNumber);
      }
    }
    return pages;
  }, [pageTasks, document.id, language]);

  return {
    status: active.status,
    error: active.error,
    savedPages,
    savedUnits,
    issuePages,
    pageTasks,
    reload: () => setReloadToken((value) => value + 1),
  };
}
