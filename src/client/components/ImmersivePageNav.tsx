import { useI18n } from "../i18n";
import type { PageStep } from "../page-keys";

interface ImmersivePageNavProps {
  /** The mouse moved recently; otherwise the buttons are invisible and let clicks through. */
  shown: boolean;
  disabled: boolean;
  atStart: boolean;
  atEnd: boolean;
  onStep: (direction: PageStep) => void;
  /** The pointer rests on a button, which keeps them shown. */
  onHold: (held: boolean) => void;
}

/**
 * Previous and next buttons at the edges of immersive reading, left and right like the arrow keys.
 * A button at the first or last page is only marked unavailable, not `disabled`: a disabled button
 * may swallow the pointerleave that releases the hold.
 */
export function ImmersivePageNav({
  shown,
  disabled,
  atStart,
  atEnd,
  onStep,
  onHold,
}: ImmersivePageNavProps) {
  const { t } = useI18n();
  const button = (direction: PageStep) => {
    const unavailable = disabled || (direction === "next" ? atEnd : atStart);
    const label = direction === "next" ? t.page.nextPage : t.page.previousPage;
    return (
      <button
        type="button"
        className={`immersive-page-step ${direction}`}
        aria-label={label}
        title={label}
        aria-keyshortcuts={direction === "next" ? "ArrowRight" : "ArrowLeft"}
        aria-disabled={unavailable}
        onClick={() => {
          if (!unavailable) onStep(direction);
        }}
        onPointerEnter={() => onHold(true)}
        onPointerLeave={() => onHold(false)}
      >
        {direction === "next" ? "›" : "‹"}
      </button>
    );
  };
  return (
    <div className={`immersive-page-nav${shown ? " revealed" : ""}`}>
      {button("prev")}
      {button("next")}
    </div>
  );
}
