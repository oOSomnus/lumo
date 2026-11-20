import type { DocumentRecord, TranslationRecord } from "../shared/contracts";
import { compareEpubCfi, isEpubPageUnit } from "../shared/epub";
import { hasRetainedDraft, type TranslationTask } from "./translation-queue";

export interface PageSource {
  pageNumber: number;
  unit: string;
  sourceCfi?: string;
  /** Trimmed; empty when the stored text was blank. */
  typst: string;
}

/**
 * The whole-page translations of one document and language, in reading order:
 * the saved records, replaced by what the queue saved since and, with
 * `drafts`, by unsaved drafts. EPUB selections stay out.
 */
export function collectPageSources(
  document: Pick<DocumentRecord, "id" | "format">,
  language: string,
  records: readonly TranslationRecord[],
  tasks: readonly TranslationTask[],
  options: { drafts: boolean },
): PageSource[] {
  const wholePage = (unit: string | undefined): boolean =>
    document.format === "epub" ? isEpubPageUnit(unit ?? "") : !unit;
  const entries = new Map<string, PageSource>();
  const put = (
    pageNumber: number,
    unit: string | undefined,
    sourceCfi: string | undefined,
    typst: string,
  ): void => {
    entries.set(`${pageNumber}/${unit ?? ""}`, {
      pageNumber,
      unit: unit ?? "",
      ...(sourceCfi ? { sourceCfi } : {}),
      typst: typst.trim(),
    });
  };
  for (const record of records) {
    if (wholePage(record.unit)) {
      put(record.pageNumber, record.unit, record.sourceCfi, record.typst);
    }
  }
  for (const task of tasks) {
    if (
      task.documentId !== document.id ||
      task.targetLanguage !== language ||
      !wholePage(task.unit)
    ) {
      continue;
    }
    if (hasRetainedDraft(task)) {
      if (options.drafts) put(task.pageNumber, task.unit, task.sourceCfi, task.draft.typst);
    } else if (task.stage === "saved" && task.saved?.typst) {
      put(task.pageNumber, task.unit, task.sourceCfi, task.saved.typst);
    }
  }
  return [...entries.values()].sort(
    (a, b) =>
      a.pageNumber - b.pageNumber ||
      compareEpubCfi(a.sourceCfi ?? "", b.sourceCfi ?? "") ||
      a.unit.localeCompare(b.unit),
  );
}

/** A document's file name without its .pdf or .epub extension. */
export function documentBaseName(name: string): string {
  return name.replace(/\.(?:pdf|epub)$/i, "");
}
