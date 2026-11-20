// Mouse movement over a reading surface. Plain DOM, no imports: the sandboxed EPUB viewer bundles this file too.

/**
 * Calls `onActive` when the pointer moves over `doc`, at most once per `intervalMs`.
 * Iframes keep their pointer events to themselves, so each frame watches its own document
 * and the reader page learns that the mouse moved anywhere over it.
 */
export function watchPointerActivity(
  doc: Document,
  onActive: () => void,
  intervalMs = 200,
): () => void {
  let last = Number.NEGATIVE_INFINITY;
  const onMove = (event: PointerEvent): void => {
    if (event.timeStamp - last < intervalMs) return;
    last = event.timeStamp;
    onActive();
  };
  doc.addEventListener("pointermove", onMove, { passive: true });
  return () => doc.removeEventListener("pointermove", onMove);
}
