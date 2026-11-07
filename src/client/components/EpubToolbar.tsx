import { useId, type Ref } from "react";
import {
  EPUB_FONT_SIZE_MAX,
  EPUB_FONT_SIZE_MIN,
  EPUB_FONT_SIZE_STEP,
  EPUB_LINE_HEIGHTS,
  EPUB_THEMES,
} from "../../shared/contracts";
import type { EpubReaderStyle } from "../../shared/epub";
import { useI18n } from "../i18n";

interface EpubToolbarProps {
  /** True until the first page is shown. */
  disabled: boolean;
  tocOpen: boolean;
  tocId: string;
  tocButtonRef: Ref<HTMLButtonElement>;
  onToggleToc: () => void;
  atStart: boolean;
  atEnd: boolean;
  onPrevious: () => void;
  onNext: () => void;
  position: {
    section: number;
    sections: number;
    page: number;
    pages: number;
  } | null;
  style: EpubReaderStyle;
  fixedLayout: boolean;
  onStyleChange: (patch: Partial<EpubReaderStyle>) => void;
  onResetStyle: () => void;
}

export function EpubToolbar({
  disabled,
  tocOpen,
  tocId,
  tocButtonRef,
  onToggleToc,
  atStart,
  atEnd,
  onPrevious,
  onNext,
  position,
  style,
  fixedLayout,
  onStyleChange,
  onResetStyle,
}: EpubToolbarProps) {
  const { t } = useI18n();
  const ids = useId();
  const reflowDisabled = disabled || fixedLayout;

  return (
    <div className="epub-toolbar" role="toolbar" aria-label={t.epub.toolbar}>
      <button
        type="button"
        ref={tocButtonRef}
        aria-expanded={tocOpen}
        aria-controls={tocOpen ? tocId : undefined}
        disabled={disabled}
        onClick={onToggleToc}
      >
        {t.epub.contents}
      </button>
      <button type="button" disabled={disabled || atStart} onClick={onPrevious}>
        {t.page.previousPage}
      </button>
      <button type="button" disabled={disabled || atEnd} onClick={onNext}>
        {t.page.nextPage}
      </button>
      <span className="epub-position" aria-live="polite">
        {position
          ? t.epub.position(
              position.section,
              position.sections,
              position.page,
              position.pages,
            )
          : t.epub.locating}
      </span>
      <details
        className="epub-settings"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !event.currentTarget.open) return;
          event.preventDefault();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }}
      >
        <summary>{t.epub.settings}</summary>
        <div className="epub-settings-panel">
          <div className="epub-setting">
            <span id={`${ids}-size`}>{t.epub.fontSize}</span>
            <div className="epub-stepper" role="group" aria-labelledby={`${ids}-size`}>
              <button
                type="button"
                aria-label={t.epub.smaller}
                disabled={reflowDisabled || style.fontSize <= EPUB_FONT_SIZE_MIN}
                onClick={() =>
                  onStyleChange({
                    fontSize: Math.max(
                      EPUB_FONT_SIZE_MIN,
                      style.fontSize - EPUB_FONT_SIZE_STEP,
                    ),
                  })
                }
              >
                A−
              </button>
              <output aria-live="polite">{t.epub.fontSizeValue(style.fontSize)}</output>
              <button
                type="button"
                aria-label={t.epub.larger}
                disabled={reflowDisabled || style.fontSize >= EPUB_FONT_SIZE_MAX}
                onClick={() =>
                  onStyleChange({
                    fontSize: Math.min(
                      EPUB_FONT_SIZE_MAX,
                      style.fontSize + EPUB_FONT_SIZE_STEP,
                    ),
                  })
                }
              >
                A+
              </button>
            </div>
          </div>
          <label className="epub-setting">
            {t.epub.fontFamily}
            <select
              value={style.fontFamily}
              disabled={reflowDisabled}
              onChange={(event) =>
                onStyleChange({
                  fontFamily: event.target.value as EpubReaderStyle["fontFamily"],
                })
              }
            >
              <option value="serif">{t.epub.serif}</option>
              <option value="sans-serif">{t.epub.sansSerif}</option>
            </select>
          </label>
          <label className="epub-setting">
            {t.epub.lineHeight}
            <select
              value={style.lineHeight}
              disabled={reflowDisabled}
              onChange={(event) =>
                onStyleChange({
                  lineHeight: Number(event.target.value) as EpubReaderStyle["lineHeight"],
                })
              }
            >
              {EPUB_LINE_HEIGHTS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="epub-setting">
            {t.epub.theme}
            <select
              value={style.theme}
              disabled={disabled}
              onChange={(event) =>
                onStyleChange({
                  theme: event.target.value as EpubReaderStyle["theme"],
                })
              }
            >
              {EPUB_THEMES.map((value) => (
                <option key={value} value={value}>
                  {t.epub[value]}
                </option>
              ))}
            </select>
          </label>
          {fixedLayout && <p className="muted epub-setting-note">{t.epub.fixedLayout}</p>}
          <button type="button" disabled={disabled} onClick={onResetStyle}>
            {t.epub.resetSettings}
          </button>
        </div>
      </details>
    </div>
  );
}
