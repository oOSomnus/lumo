import type { TranslatePageInput, TypstRepair } from "../shared/contracts";
import { PagePreparationError } from "./pdf";
import type { PreparedTranslationPage, TranslationTask } from "./translation-queue";

type TaskIdentity = Pick<
  TranslationTask,
  "documentId" | "pageNumber" | "targetLanguage" | "force" | "unit" | "sourceCfi"
>;

function identity(task: TaskIdentity) {
  return {
    documentId: task.documentId,
    pageNumber: task.pageNumber,
    targetLanguage: task.targetLanguage,
    force: task.force,
  };
}

function epubRange(task: TaskIdentity): { unit: string; sourceCfi: string } {
  if (!task.unit || !task.sourceCfi) {
    throw new PagePreparationError("EPUB_PAGE_UNAVAILABLE", "the task has no page range");
  }
  return { unit: task.unit, sourceCfi: task.sourceCfi };
}

/** The request that generates a translation: the page, plus the reference-only neighbouring excerpts. */
export function generationRequest(
  task: TaskIdentity,
  prepared: PreparedTranslationPage,
): TranslatePageInput {
  const context = prepared.context ? { context: prepared.context } : {};
  if (prepared.format === "epub") {
    return {
      ...identity(task),
      format: "epub",
      ...epubRange(task),
      xhtml: prepared.xhtml,
      images: prepared.images,
      ...context,
    };
  }
  return {
    ...identity(task),
    format: "pdf",
    ...(task.unit ? { unit: task.unit } : {}),
    text: prepared.text,
    imageBase64: prepared.imageBase64,
    ...context,
  };
}

/** A repair request carries the failing candidate and its diagnostics only: no source, no neighbours. */
export function repairRequest(task: TaskIdentity, repair: TypstRepair): TranslatePageInput {
  if (task.sourceCfi) {
    return { ...identity(task), format: "epub", ...epubRange(task), repair };
  }
  return {
    ...identity(task),
    format: "pdf",
    ...(task.unit ? { unit: task.unit } : {}),
    repair,
  };
}
