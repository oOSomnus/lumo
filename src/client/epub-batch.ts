import type { TargetLanguage } from "../shared/contracts";
import type { EpubLayoutSnapshot } from "../shared/epub";
import type { EpubBridge } from "./epub-bridge";
import type { UiError } from "./i18n";
import {
  hasRetainedDraft,
  type EnqueueTranslation,
  type TranslationTask,
} from "./translation-queue";

/** Progress of splitting the chosen sections into screen pages; it outlives the batch tab. */
export interface EpubBatchState {
  status: "idle" | "running" | "done" | "error";
  found: number;
  queued: number;
  error: UiError | null;
}

export const IDLE_EPUB_BATCH: EpubBatchState = {
  status: "idle",
  found: 0,
  queued: 0,
  error: null,
};

/** A task a new batch must leave alone: waiting, running, or holding an unsaved draft. */
export function isOpenTask(
  task: Pick<TranslationTask, "stage" | "draft"> | undefined,
): boolean {
  if (!task) return false;
  return (
    task.stage !== "saved" &&
    task.stage !== "error" &&
    (task.stage !== "cancelled" || hasRetainedDraft(task))
  );
}

export interface EpubBatchOptions {
  bridge: Pick<EpubBridge, "pages">;
  /** The viewport and reading settings frozen when the batch starts. */
  layout: EpubLayoutSnapshot;
  /** Spine indexes of the chosen sections, ascending. */
  sectionIndexes: readonly number[];
  documentId: string;
  language: TargetLanguage;
  retranslate: boolean;
  /** `${pageNumber}/${unit}` of every page already translated in this language. */
  saved: ReadonlySet<string>;
  /** True when a task for this page exists that must not be queued again. */
  isBusy(pageNumber: number, unit: string): boolean;
  /** Asked once with how many saved pages would be regenerated; false queues nothing. */
  confirmRetranslate(count: number): Promise<boolean>;
  enqueue(input: EnqueueTranslation): void;
  onFound(found: number): void;
  signal: AbortSignal;
}

export interface EpubBatchResult {
  found: number;
  queued: number;
}

/**
 * Splits the chosen sections into the screen pages of the frozen layout and
 * queues one task per page that still needs a translation. Pages are queued as
 * they are discovered, except when regenerating: the user is asked first, so
 * every page is discovered before anything is queued. Returns null when that
 * confirmation was declined. A cancelled signal rejects with the pages() error.
 */
export async function runEpubBatch(
  options: EpubBatchOptions,
): Promise<EpubBatchResult | null> {
  const { layout, signal } = options;
  const result: EpubBatchResult = { found: 0, queued: 0 };
  const held: { input: EnqueueTranslation; saved: boolean }[] = [];

  for await (const page of options.bridge.pages(options.sectionIndexes, layout, signal)) {
    signal.throwIfAborted();
    result.found += 1;
    options.onFound(result.found);
    const pageNumber = page.sectionIndex + 1;
    if (options.isBusy(pageNumber, page.unit)) continue;
    const saved = options.saved.has(`${pageNumber}/${page.unit}`);
    if (saved && !options.retranslate) continue;
    const input: EnqueueTranslation = {
      documentId: options.documentId,
      pageNumber,
      targetLanguage: options.language,
      unit: page.unit,
      sourceCfi: page.sourceCfi,
      epubLayout: layout,
      epubPage: { page: page.page, total: page.total },
      force: options.retranslate,
      priority: "batch",
    };
    if (options.retranslate) {
      held.push({ input, saved });
    } else {
      options.enqueue(input);
      result.queued += 1;
    }
  }

  if (options.retranslate) {
    const regenerated = held.filter((item) => item.saved).length;
    if (regenerated > 0 && !(await options.confirmRetranslate(regenerated))) {
      return null;
    }
    signal.throwIfAborted();
    for (const { input } of held) options.enqueue(input);
    result.queued = held.length;
  }
  return result;
}

export type UntranslatedEpubSectionsOptions = Pick<
  EpubBatchOptions,
  "bridge" | "layout" | "sectionIndexes" | "saved" | "onFound" | "signal"
>;

/**
 * The numbers of the sections that still have a screen page, at the frozen
 * layout, without a saved translation: a section translated only in part, or
 * only at another layout, is still listed. Rejects like `runEpubBatch` when
 * the signal aborts or the pages cannot be located.
 */
export async function findUntranslatedEpubSections(
  options: UntranslatedEpubSectionsOptions,
): Promise<number[]> {
  const { signal } = options;
  const sections = new Set<number>();
  let found = 0;
  for await (const page of options.bridge.pages(options.sectionIndexes, options.layout, signal)) {
    signal.throwIfAborted();
    found += 1;
    options.onFound(found);
    const pageNumber = page.sectionIndex + 1;
    if (!options.saved.has(`${pageNumber}/${page.unit}`)) sections.add(pageNumber);
  }
  return [...sections].sort((a, b) => a - b);
}
