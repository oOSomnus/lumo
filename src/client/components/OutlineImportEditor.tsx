import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import type { OutlineEntry } from "../../shared/contracts";
import { errorText, useI18n, type UiError } from "../i18n";
import {
  buildOutlineImportPrompt,
  MAX_OUTLINE_IMPORT_CHARS,
  parseOutlineImport,
} from "../outline-import";

interface OutlineImportEditorProps {
  pageCount: number;
  draft: string;
  saving: boolean;
  /** Why the last save or removal failed. */
  error: UiError | null;
  onDraftChange: (draft: string) => void;
  onSave: (entries: OutlineEntry[]) => void;
  onCancel: () => void;
}

/**
 * Edits an outline in the import format (pasted, loaded from a file or written by
 * hand), checks it line by line as it changes, and saves it only once it is valid.
 */
export function OutlineImportEditor({
  pageCount,
  draft,
  saving,
  error,
  onDraftChange,
  onSave,
  onCancel,
}: OutlineImportEditorProps) {
  const { locale, t } = useI18n();
  const copy = t.outline.editor;
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  // Bumped whenever the draft changes hands (a new read, an edit, save, cancel or unmount),
  // so a file read that finishes later only fills the draft if nothing happened since.
  const editToken = useRef(0);
  useEffect(
    () => () => {
      editToken.current += 1;
    },
    [],
  );
  const [notice, setNotice] = useState<"copied" | "copyFailed" | "fileFailed" | "tooLarge" | null>(null);
  const deferredDraft = useDeferredValue(draft);
  const result = useMemo(
    () => parseOutlineImport(deferredDraft, pageCount),
    [deferredDraft, pageCount],
  );
  const current = deferredDraft === draft;

  const copyPrompt = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildOutlineImportPrompt(pageCount));
      setNotice("copied");
    } catch {
      setNotice("copyFailed");
    }
  };

  const openFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    if (file.size > MAX_OUTLINE_IMPORT_CHARS) {
      setNotice("tooLarge");
      return;
    }
    const token = ++editToken.current;
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (token === editToken.current) setNotice("fileFailed");
      return;
    }
    if (token !== editToken.current) return;
    onDraftChange(text);
    setNotice(null);
  };

  const edit = (text: string): void => {
    editToken.current += 1;
    onDraftChange(text);
  };

  const save = (): void => {
    editToken.current += 1;
    // Checks the text as it is now, not the deferred copy the summary shows.
    const latest = parseOutlineImport(draft, pageCount);
    if (latest.ok) onSave(latest.entries);
  };

  const cancel = (): void => {
    editToken.current += 1;
    onCancel();
  };

  const noticeText =
    notice === "copied"
      ? copy.promptCopied
      : notice === "copyFailed"
        ? copy.promptCopyFailed
        : notice === "fileFailed"
          ? copy.fileFailed
          : notice === "tooLarge"
            ? copy.errors.too_large
            : null;

  return (
    <div className="outline-import" role="group" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{copy.title}</h4>
      <p className="muted">{copy.intro}</p>
      <p className="muted">{copy.replaceNote}</p>
      <div className="inline-actions">
        <button type="button" onClick={() => void copyPrompt()}>
          {copy.copyPrompt}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => fileInput.current?.click()}
        >
          {copy.openFile}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void openFile(file);
          }}
        />
      </div>
      {noticeText && (
        <p className={notice === "copied" ? "muted" : "field-error"} role="status">
          {noticeText}
        </p>
      )}
      <label className="sr-only" htmlFor={`${id}-text`}>
        {copy.textLabel}
      </label>
      <textarea
        id={`${id}-text`}
        className="outline-import-text"
        rows={10}
        spellCheck={false}
        autoFocus
        value={draft}
        placeholder={copy.placeholder}
        disabled={saving}
        aria-describedby={`${id}-check`}
        onChange={(event) => edit(event.currentTarget.value)}
      />
      <div id={`${id}-check`} aria-live="polite">
        {result.ok ? (
          <p className="muted">
            {copy.summary(
              result.entries.length,
              result.entries[0]!.pageNumber,
              result.entries.at(-1)!.pageNumber,
            )}
          </p>
        ) : draft.trim().length > 0 ? (
          <div className="field-error">
            <p>{copy.problems}</p>
            <ul>
              {result.errors.map((problem) => (
                <li key={`${problem.line}-${problem.code}`}>
                  {copy.errorAt(problem.line, copy.errors[problem.code])}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {errorText(error, locale)}
        </p>
      )}
      <div className="inline-actions">
        <button
          type="button"
          className="primary"
          disabled={saving || !current || !result.ok}
          onClick={save}
        >
          {saving ? t.outline.saving : copy.save}
        </button>
        <button type="button" disabled={saving} onClick={cancel}>
          {copy.cancel}
        </button>
      </div>
    </div>
  );
}
