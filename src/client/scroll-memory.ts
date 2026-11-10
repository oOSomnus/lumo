import {
  READER_SCROLL_MEMORY_LIMIT,
  type ReaderScrollMemory,
  type ReaderView,
} from "../shared/contracts";

export interface PdfScrollPosition {
  page: number;
  left: number;
  top: number;
}

export interface TranslationScrollPosition {
  key: string;
  offset: number;
}

export function scrollMemoryOf(view: ReaderView): ReaderScrollMemory {
  return view.scrollMemory ?? { pdf: [], translation: [] };
}

/** Records a position, replacing an older one for the same page and dropping the oldest entry. */
export function rememberPdfScroll(
  memory: ReaderScrollMemory,
  position: PdfScrollPosition,
): ReaderScrollMemory {
  const rest = memory.pdf.filter((entry) => entry.page !== position.page);
  return { ...memory, pdf: [position, ...rest].slice(0, READER_SCROLL_MEMORY_LIMIT) };
}

export function rememberTranslationScroll(
  memory: ReaderScrollMemory,
  position: TranslationScrollPosition,
): ReaderScrollMemory {
  const rest = memory.translation.filter((entry) => entry.key !== position.key);
  return {
    ...memory,
    translation: [position, ...rest].slice(0, READER_SCROLL_MEMORY_LIMIT),
  };
}

/** Moves a known position to the front without replacing its value; a new page adds nothing. */
export function touchPdfScroll(
  memory: ReaderScrollMemory,
  page: number,
): ReaderScrollMemory {
  const index = memory.pdf.findIndex((entry) => entry.page === page);
  if (index <= 0) return memory;
  const entry = memory.pdf[index]!;
  return {
    ...memory,
    pdf: [entry, ...memory.pdf.slice(0, index), ...memory.pdf.slice(index + 1)],
  };
}

export function touchTranslationScroll(
  memory: ReaderScrollMemory,
  key: string,
): ReaderScrollMemory {
  const index = memory.translation.findIndex((entry) => entry.key === key);
  if (index <= 0) return memory;
  const entry = memory.translation[index]!;
  return {
    ...memory,
    translation: [
      entry,
      ...memory.translation.slice(0, index),
      ...memory.translation.slice(index + 1),
    ],
  };
}

export function sameScrollMemory(
  a: ReaderScrollMemory | undefined,
  b: ReaderScrollMemory | undefined,
): boolean {
  const left = a ?? { pdf: [], translation: [] };
  const right = b ?? { pdf: [], translation: [] };
  return (
    left.pdf.length === right.pdf.length &&
    left.translation.length === right.translation.length &&
    left.pdf.every((entry, index) => {
      const other = right.pdf[index]!;
      return (
        entry.page === other.page &&
        entry.left === other.left &&
        entry.top === other.top
      );
    }) &&
    left.translation.every((entry, index) => {
      const other = right.translation[index]!;
      return entry.key === other.key && entry.offset === other.offset;
    })
  );
}
