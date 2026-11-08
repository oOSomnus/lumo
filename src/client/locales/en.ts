import type { LauncherLogCode } from "../../shared/desktop";

export type ErrorParams = Record<string, string | number>;
export type ErrorMessage = (params: ErrorParams) => string;

export const en = {
  appTitle: "Lumo · PDF & EPUB reader with translation",
  common: {
    cancel: "Cancel",
    close: "Close",
    confirm: "Confirm",
    retry: "Retry",
    technicalDetails: "Technical details",
    save: "Save",
    delete: "Delete",
    download: "Download",
    openPdf: "Open file",
    listSeparator: "; ",
    sectionOf: (section: number, total: number) =>
      `Section ${section} / ${total || "?"}`,
    pageLabel: (page: number) => `Page ${page}`,
    pageOf: (page: number, total: number) => `Page ${page} / ${total || "?"}`,
  },
  file: {
    editedCopySuffix: " (edited copy)",
  },
  stages: {
    queued: "Waiting",
    preparing: "Preparing page",
    generating: "Generating",
    repairing: "Repairing Typst",
    validating: "Validating Typst",
    saving: "Saving",
    saved: "Saved",
    error: "Failed",
    unsaved: "Unsaved",
    cancelled: "Cancelled",
  },
  appBar: {
    library: "Library",
    openPdf: "Open file",
    noPdf: "No document open",
    saveModifiedCopy: "Save edited copy",
    savingCopy: "Saving copy…",
    discardChanges: "Discard changes",
    fullscreen: "Full-screen compare",
    settings: "Settings",
  },
  gates: {
    accessTitle: "Lumo",
    missingToken: "Access code missing. Open Lumo from its window with “Open WebUI”, or use the complete link printed in the terminal.",
    tokenRotates: "A new link is generated each time the server starts; old links stop working.",
    opening: "Opening the library…",
    libraryFailedTitle: "Cannot open the library",
    libraryUnavailable: "Library data is not available.",
    retry: "Retry",
  },
  banners: {
    progressNotSaved: "Reading progress was not saved.",
    viewNotSaved: "Reading view was not saved.",
    viewRestoreFailed: "Could not restore the reading view; using the default view.",
    saveCopyFailed: (detail: string) => `Could not save the edited copy: ${detail}`,
    importFailed: (detail: string) => `Import failed: ${detail}`,
    retryImport: "Retry import",
  },
  tabs: {
    readingView: "Reading view",
    original: "Original",
    translation: "Translation",
    batch: "Batch",
    translationView: "Translation view",
    currentPage: "Current page",
    batchTranslation: "Batch translation",
  },
  splitter: "Resize the original and translation panes",
  layout: {
    label: "Pane layout",
    leftOnly: "Left only",
    rightOnly: "Right only",
    equal: "Equal split",
    leftWide: "Left wider",
    rightWide: "Right wider",
  },
  ai: {
    checking: "Reading the AI settings…",
    checkFailed: (detail: string) => `Could not read the AI settings: ${detail}`,
    retryCheck: "Retry reading AI settings",
    notConfigured: "AI translation is not set up yet.",
    configure: "Configure AI to translate",
    openSettings: "Open AI settings",
  },
  empty: {
    openPdf: "Open a document to start reading. You can also drop a file here.",
    noPdfOpen: "No document is open.",
    filesSaved: "Files are saved in the local data directory and restored after the browser closes.",
    batchHint: "Open a document to translate several pages in parallel.",
  },
  viewer: {
    reopen: "Reopen",
    tools: "Reading tools",
  },
  translation: {
    preview: "Preview",
    source: "Source",
    editSource: "Edit source",
    saveSource: "Save",
    discardSource: "Discard changes",
    sourceLabel: "Typst source",
    previewLabel: "Typst preview",
    compiling: "Compiling the preview…",
    compileFailed: "The Typst source does not compile yet. The draft is kept for editing.",
    liveSource: "Live Typst source",
    highlightUnavailable: "Syntax highlighting is unavailable; the source is kept in full.",
  },
  page: {
    actualOrder: "(actual page order)",
    targetLanguage: "Target language",
    retranslate: "Regenerate translation",
    regenerateHint:
      "Use current AI settings; the previous translation is kept until the new one is saved.",
    translate: "Translate this page",
    translateSelection: "Translate selection",
    previousPage: "Previous page",
    nextPage: "Next page",
    selection: (text: string) => `Selected: ${text}`,
    clearSelection: "Clear selection",
    export: "Export",
    existingTranslation: " · used saved translation",
    waitingModel: "Waiting for the model to return text…",
    cancelPage: "Cancel this page",
    retrySave: "Retry save",
    discardDraft: "Discard draft",
    retry: "Retry",
    repair: "Repair Typst",
    continueRepair: "Continue repair",
    readingStored: "Reading saved translation…",
    storedReadFailedTitle: "Could not read the saved translation",
    emptyGuide: "Translate this page with the button above to see it here.",
    consent:
      "Translation sends the current page to the configured AI service together with small excerpts of the previous and next pages (text, or a thin image strip when there is no text). The excerpts are reference only: they are not translated or saved. The whole document is not sent.",
    consentSummary: "Sends this page and short excerpts of the neighboring pages to your AI service.",
    consentDetails: "What is sent",
    cacheHint: "saved translation",
    contextWarning:
      "Some neighboring context could not be read, so this page was translated with less surrounding context.",
    originalRange: "Original page range",
    originalRangeNote: (position: string) =>
      `Showing the translation of an earlier page range (${position}). The reading layout has changed since, so that range may span several pages now.`,
    showVisiblePage: "Show the page on screen",
    mode: {
      notInLibrary: "Not in library",
      readingStored: "Reading saved translation",
      storedReadFailed: "Could not read saved translation",
      saved: "Saved",
      notTranslated: "Not translated",
    },
    disabled: {
      previewOnly: "This file is not in the library yet. Retry the import before translating.",
      noPdf: "Open a document first.",
      loading: "The document is still loading.",
      modified: "The PDF has unsaved edits. Save an edited copy or discard them before generating new translations.",
      outlineBusy:
        "An outline is being generated or saved. Wait for it to finish before translating.",
      unsavedDraft: "Repair, save or discard the current draft first.",
      locating: "The visible page is still being located.",
      noContent: "This page has no text or image the reader can translate.",
    },
    unsaved: {
      title: "Unsaved",
      body: "The translation is not saved yet. The draft is kept, and the previous translation was not overwritten.",
      saveFailed: (detail: string) => `Save failed: ${detail}`,
      validationFailed: (detail: string) => `Typst check failed: ${detail}`,
      repairFailed: (detail: string) => `Repair failed: ${detail}`,
      operationFailed: (detail: string) =>
        `Could not complete the operation: ${detail}`,
    },
    cancelledKept: "Regeneration cancelled; previous translation kept",
    cancelled: "Cancelled",
    failedKept: "Regeneration failed; previous translation kept",
    failed: "Translation failed",
  },
  repair: {
    title: "Typst repair",
    note: "Calls AI only when the compiler rejects the draft, and keeps going until it compiles or you cancel; may cost money.",
    round: (round: number) => `Round ${round}`,
    earlierRoundsOmitted: (count: number) => `Details of ${count} earlier round(s) are omitted.`,
    status: {
      requesting: "Waiting for the model",
      validating: "Changes applied; waiting for compile",
      "compile-failed": "Still does not compile",
      "compile-passed": "Compiles",
      rejected: "Reply rejected; asking again",
      "request-failed": "Repair request failed",
      cancelled: "Cancelled",
    },
    requesting: (reply: number) => `Requested model reply ${reply}`,
    rejected: (reply: number, message: string) =>
      `Reply ${reply} rejected: ${message}`,
    appliedEdits: (reply: number, count: number) =>
      `Reply ${reply}: ${count} local replacement(s) applied`,
    appliedRewrite: (reply: number) => `Reply ${reply}: full source rewritten`,
    diagnostics: "Compiler diagnostics",
    changeAt: (line: number) => `Changed from line ${line}`,
    rangeNote:
      "Shows the covering range; unchanged lines between edits may be included.",
    before: "Before (removed)",
    after: "After (added)",
    resultDiagnostics: "Compiler result after this round",
    savedFailedAfterCompile: "The source compiled, but saving failed.",
    cancelledDraftKept: "Repair cancelled. The latest draft is kept.",
    saved: "Saved",
  },
  errors: {
    LOCAL_ACCESS_REQUIRED: () =>
      "The access code is missing or invalid. Open Lumo from its window with “Open WebUI”, or use the link printed in the terminal.",
    FORBIDDEN: () => "This request was not accepted by the local server.",
    INVALID_REQUEST: () => "The request was not valid.",
    PAYLOAD_TOO_LARGE: () => "The request is too large.",
    NOT_FOUND: () => "The requested item does not exist.",
    METHOD_NOT_ALLOWED: () => "This action is not supported.",
    DOCUMENT_NOT_FOUND: () => "This document no longer exists in the library.",
    DOCUMENT_CONFLICT: () => "This file is already stored with different metadata.",
    STORAGE_BUSY: () => "The database is busy. Try again shortly.",
    STORAGE_FULL: () => "The disk is full. Free some space and try again.",
    STORAGE_ERROR: () => "The local database could not be read or written.",
    AI_NOT_CONFIGURED: () =>
      "AI translation is not configured. Open Settings and choose a vision model with credentials.",
    AI_MODEL_UNSUPPORTED: () =>
      "The selected model does not support this setup. Choose a vision model and a reasoning effort it supports in Settings.",
    AI_AUTH_FAILED: () =>
      "AI authentication failed. Sign in again or replace the saved credential.",
    AI_CONFIG_INVALID: () =>
      "The saved AI configuration is invalid. Open Settings and choose it again.",
    INVALID_AI_SETTINGS: () =>
      "Check the provider, model, endpoint, token limits and reasoning effort.",
    AI_REQUEST_FAILED: () => "The AI request failed.",
    INVALID_AI_OUTPUT: () => "The model did not return a usable translation.",
    AI_PROVIDER_NOT_FOUND: () => "That AI provider is not available.",
    AI_LOGIN_BUSY: () => "Another AI sign-in is already in progress.",
    AI_LOGIN_NOT_FOUND: () => "That sign-in session is no longer active. Start again.",
    AI_LOGIN_STALE_PROMPT: () => "That sign-in prompt has expired.",
    AI_LOGIN_FAILED: () => "Provider sign-in failed. Review its instructions and retry.",
    AI_LOGIN_EXPIRED: () => "Sign-in expired. Start again.",
    AI_LOGIN_INTERRUPTED: () => "The sign-in connection ended before it finished.",
    AI_TIMEOUT: () => "The translation timed out.",
    HTTP_ERROR: () => "The local server returned an error.",
    INVALID_RESPONSE: () => "The server response could not be read.",
    STREAM_INTERRUPTED: () => "The connection ended before the translation completed.",
    ABORTED: () => "The action was cancelled.",
    TRANSLATION_FAILED: () => "Translation failed.",
    TYPST_COMPILE_FAILED: () =>
      "The Typst source does not compile. The draft is kept for editing.",
    TYPST_COMPILE_TIMEOUT: () =>
      "Typst compilation timed out. The draft is kept; try again.",
    TYPST_RUNTIME_UNAVAILABLE: () =>
      "The local Typst runtime is unavailable. Reload and try again.",
    EXPORT_EMPTY: () => "This page has no complete translation to export.",
    EXPORT_NONE: () => "No complete translations to export yet.",
    LANGUAGE_RELOAD_BLOCKED: () =>
      "Finish the current translation, save or discard PDF edits, and leave the library before changing the language.",
    VIEW_SAVE_FAILED: () =>
      "The reading view could not be saved. Retry before switching the language.",
    SELECTION_EMPTY: () => "Enter page numbers, for example 1,3-5,12.",
    SELECTION_EMPTY_TOKEN: () => "Page numbers must not contain empty items.",
    SELECTION_INVALID_TOKEN: (params) =>
      `Unrecognized page expression: ${params.token ?? ""}`,
    SELECTION_TOKEN_TOO_LARGE: (params) =>
      `Page number is out of range: ${params.token ?? ""}`,
    SELECTION_OUT_OF_BOUNDS: (params) =>
      `Pages must be between 1 and ${params.pageCount ?? "?"}: ${params.token ?? ""}`,
    SELECTION_REVERSED_RANGE: (params) =>
      `Range starts after it ends: ${params.token ?? ""}`,
    COPY_PAGE_COUNT_MISMATCH: (params) =>
      `The copy has ${params.actual ?? "?"} pages; expected ${params.expected ?? "?"}.`,
    COPY_ENCRYPTED: () =>
      "The copy is encrypted and the password is missing or incorrect. The original file was not replaced.",
    PDF_RUNTIME_UNAVAILABLE: () => "The PDF runtime is not available.",
    PDF_NOT_READY: () => "The PDF is not open yet.",
    EPUB_NOT_READY: () => "The EPUB is not open yet.",
    EPUB_OPEN_FAILED: () => "The EPUB could not be opened.",
    PDF_VIEWER_UNAVAILABLE: () => "The PDF.js viewer could not be initialized.",
    PDF_OPEN_FAILED: () => "The PDF could not be opened.",
    INVALID_PDF_FILE: () => "Choose a PDF file.",
    INVALID_DOCUMENT_FILE: () => "Choose a PDF or EPUB file.",
    EMPTY_DOCUMENT_FILE: () => "That file is empty.",
    EMPTY_PDF_FILE: () => "The PDF file is empty.",
    COPY_CHANGED_DURING_SAVE: () =>
      "New edits arrived while saving. The copy was stored, but the current editor was not switched; save again.",
    PDF_NOT_SAVED: () => "The PDF has not been added to the library yet.",
    DOCUMENT_CHANGED: () => "The document changed.",
    PAGE_TEXT_TOO_LARGE: (params) =>
      `This page produced ${params.length ?? "?"} characters, over the 100000 limit.`,
    PAGE_RENDER_FAILED: () => "The page could not be rendered.",
    PAGE_IMAGE_TOO_LARGE: () =>
      "The page image exceeds the 6000000 character limit.",
    EPUB_NAVIGATION_FAILED: () =>
      "The book could not move to that position or apply that setting.",
    EPUB_PAGE_UNAVAILABLE: () =>
      "The visible page could not be located in the book. Turn the page or resize the window and try again.",
    EPUB_PAGE_TOO_LARGE: () =>
      "The text of this page is over the 100000 character limit.",
    PAGE_ASSETS_TOO_LARGE: () =>
      "The images of this page are too large to use together.",
    OUTLINE_INVALID: () =>
      "The PDF outline could not be used. Select pages manually.",
    OUTLINE_EMPTY: () =>
      "No headings were identified. Select pages manually.",
    UNKNOWN: () => "Something went wrong.",
  } satisfies Record<string, ErrorMessage>,
  confirm: {
    defaultLabel: "Confirm",
    switchTitle: "Switch documents?",
    switchActive: "a translation is still running",
    switchDrafts: (count: number) =>
      `${count} generated page${count === 1 ? "" : "s"} ${
        count === 1 ? "is" : "are"
      } not saved`,
    switchModified: "the PDF has unsaved edits",
    switchPreview: "the current PDF is not in the library",
    switchOutlineActive: "an outline is being generated or saved",
    switchOutlineUnsaved: "a generated outline is not saved",
    switchBody: (reasons: string) =>
      `${reasons}. Continuing stops tasks and discards unsaved new text; saved translations are kept.`,
    switchConfirm: "Switch anyway",
    exportDrafts: "Export unsaved translations first",
    retranslateTitle: "Regenerate this page?",
    retranslateBody:
      "Regenerating uses the current model and reasoning effort and calls the AI service again, which may incur charges. The previous translation is kept if it fails.",
    retranslateConfirm: "Regenerate",
    retranslateSavedTitle: "Regenerate saved pages",
    retranslateSavedBody: (count: number) =>
      `${count} page${count === 1 ? "" : "s"} with saved translations will be regenerated with the current settings, incurring new API charges. Previous translations are kept if it fails.`,
    retranslateSavedConfirm: "Start regeneration",
    deleteTitle: "Delete document?",
    deleteBody: (name: string, warnings: string) =>
      `“${name}”, its PDF and translations in every language will be deleted. This cannot be undone.${
        warnings ? ` ${warnings}.` : ""
      }`,
    deleteActive: "the current translation task will stop",
    deleteDrafts: (count: number) =>
      `${count} unsaved translation${count === 1 ? "" : "s"} will be discarded`,
    deleteModified: "unsaved PDF edits will be discarded",
    discardTitle: "Discard changes?",
    discardBody:
      "The original file will be reloaded. Unsaved form fields and annotation changes will be lost; saved translations are kept.",
    discardConfirm: "Discard changes",
    discardDraftTitle: "Discard unsaved translation?",
    discardDraftBody:
      "This new text has not been written to disk. It cannot be recovered after discarding. The previous translation is kept.",
    discardDraftConfirm: "Discard",
    removeCredentialTitle: "Remove this credential?",
    removeCredentialBody: (provider: string) =>
      `Lumo will forget the saved credential for ${provider}. This signs out locally only; it does not revoke the token at the provider.`,
    removeCredentialConfirm: "Remove credential",
    endpointTitle: "Use the saved credential with a new endpoint?",
    endpointBody: (destination: string) =>
      `A credential is already stored for this provider. Saving will send it to ${destination}. Only continue if you trust that endpoint.`,
    endpointConfirm: "Use this endpoint",
  },
  export: {
    title: "Export translation",
    currentPage: "This page as Typst",
    allPages: "All translated content in this language (ZIP)",
    noCurrent: "This page has no complete translation to export.",
    none: "No complete translations to export yet.",
    failed: (detail: string) => `Export failed: ${detail}`,
  },
  library: {
    title: "Library",
    empty: "The library is empty. Open a PDF or EPUB to start.",
    recentlyRead: (date: string) => `last read ${date}`,
    returnToReader: "Return to reading",
    coverUnavailable: "Cover unavailable",
    loadFailed: (detail: string) => `Could not load the library: ${detail}`,
    deleteFailed: (detail: string) => `Delete failed: ${detail}`,
    downloadFailed: (detail: string) => `Download failed: ${detail}`,
  },
  batch: {
    targetLanguage: "Target language",
    selectPages: "Select pages",
    expression: "Page expression",
    expressionPlaceholder: "e.g. 1,3-5,12",
    apply: "Apply",
    currentPage: "Current page",
    allPages: "All pages",
    untranslatedPages: "Untranslated pages",
    clear: "Clear",
    readTranslatedFailed: (detail: string) => `Could not read translated pages: ${detail}`,
    previousGroup: "Previous group",
    nextGroup: "Next group",
    pageRange: (first: number, last: number, total: number) =>
      `Pages ${first}–${last} (${total} total)`,
    pageCheckboxes: "Page selection",
    markerTranslated: "Translated",
    markerTask: "Task",
    method: {
      legend: "Select by",
      outline: "By outline",
      pages: "By page numbers",
      sections: "By section number",
      useSections: "Select by section number instead",
    },
    pdfSummary: (selected: number, blocked: number, saved: number, candidates: number) =>
      `${selected} selected · ${blocked} skipped (task or unsaved draft) · ${saved} skipped (already translated) · ${candidates} to translate`,
    cost: (candidates: number) =>
      `${candidates} page${candidates === 1 ? "" : "s"} will be translated. This may incur provider charges, and automatic repair can add more requests.`,
    retranslateSaved: "Regenerate saved pages (incurs charges)",
    allCovered:
      "The selected pages already have translations or tasks. Tick “Regenerate saved pages” to generate them again.",
    resumeQueue: "Resume queue",
    start: (count: number) => `Start translation${count > 0 ? ` (${count})` : ""}`,
    stopAll: "Stop all",
    retryFailed: "Retry failed tasks in this book (all languages)",
    progress: (
      finished: number,
      total: number,
      active: number,
      queued: number,
      failed: number,
    ) =>
      `${finished} / ${total} complete, ${active} running, ${queued} queued, ${failed} failed (up to 3 pages in parallel)`,
    tasks: "Translation tasks",
    noTasks: "No tasks yet. Select pages and start translating.",
    existing: "used saved translation",
    epub: {
      selectSections: "Select sections",
      expression: "Section expression",
      currentSection: "Current section",
      allSections: "All sections",
      untranslatedSections: "Untranslated sections",
      sectionRange: (first: number, last: number, total: number) =>
        `Sections ${first}–${last} (${total} total)`,
      sectionCheckboxes: "Section selection",
      markerTranslated: "Has translations",
      selectedSummary: (sections: number) =>
        `${sections} section${sections === 1 ? "" : "s"} selected · screen pages are set by the current layout when you start`,
      start: (count: number) =>
        `Start translation${count > 0 ? ` (${count} section${count === 1 ? "" : "s"})` : ""}`,
      note: "Starting splits each selected section into the screen pages of the current window size and reading settings, then translates every page on its own. Changing the settings afterwards does not change pages already queued.",
      finding: (found: number) => `Finding pages… ${found} found`,
      found: (found: number, queued: number) =>
        `${found} pages found · ${queued} queued`,
      findFailed: (detail: string) =>
        `Could not split the sections into pages: ${detail}`,
      taskPage: (
        section: number,
        position: { page: number; total: number } | null,
        id: string,
      ) =>
        position
          ? `Section ${section} · page ${position.page} / ${position.total}`
          : `Section ${section} · page …${id}`,
    },
  },
  outline: {
    sectionTitle: "Select by outline",
    loading: "Reading the outline…",
    loadFailed: (detail: string) => `Could not read the outline: ${detail}`,
    reload: "Reload outline",
    sourceNative: "Document outline",
    sourceGenerated: "AI-generated outline",
    skipped: (count: number) =>
      `${count} outline item${count === 1 ? "" : "s"} without a page ${
        count === 1 ? "was" : "were"
      } skipped.`,
    note: "Translation uses whole PDF pages; sections that start on the same page may overlap.",
    noteEpub:
      "Selecting a heading selects its whole sections; headings that point at the same section overlap.",
    generate: "Generate outline with AI",
    retryGenerate: "Try again",
    generateTitle: "Generate an outline with AI?",
    generateBody: (pages: number) =>
      `This sends the text and image of each of the ${pages} pages to the configured vision model, one page at a time. It can take a while and may incur charges. Review the generated headings before translating.`,
    generateConfirm: "Generate outline",
    disabledActive:
      "Finish or cancel running translation tasks before generating an outline.",
    generating: (processed: number, total: number) =>
      `Identifying headings: page ${processed} / ${total}`,
    cancelGeneration: "Cancel generation",
    saving: "Saving the outline…",
    unsavedTitle: "Outline not saved",
    unsavedBody:
      "The generated outline is still in memory and can be used for selection. Retry saving it or discard it.",
    retrySave: "Retry saving outline",
    discard: "Discard outline",
    pageRange: (start: number, end: number) =>
      start === end ? `Page ${start}` : `Pages ${start}–${end}`,
    toggle: (title: string) => `Expand or collapse ${title}`,
    selectRange: (start: number, end: number) =>
      start === end ? `Select page ${start}` : `Select pages ${start}–${end}`,
    sectionRange: (start: number, end: number) =>
      start === end ? `Section ${start}` : `Sections ${start}–${end}`,
    selectSectionRange: (start: number, end: number) =>
      start === end ? `Select section ${start}` : `Select sections ${start}–${end}`,
  },
  epub: {
    toolbar: "EPUB reading controls",
    contents: "Contents",
    contentsTitle: "Contents of this book",
    closeContents: "Close contents",
    noContents: "This EPUB has no contents.",
    toggleGroup: (label: string) => `Expand or collapse ${label}`,
    position: (section: number, sections: number, page: number, pages: number) =>
      `Section ${section} / ${sections || "?"} · page ${page} / ${pages}`,
    locating: "Locating…",
    noContent: "Nothing to translate on this page",
    settings: "Reading settings",
    fontSize: "Font size",
    smaller: "Smaller text",
    larger: "Larger text",
    fontSizeValue: (size: number) => `${size} px`,
    fontFamily: "Font",
    serif: "Serif",
    sansSerif: "Sans-serif",
    lineHeight: "Line spacing",
    theme: "Theme",
    light: "Light",
    sepia: "Sepia",
    dark: "Dark",
    resetSettings: "Restore defaults",
    fixedLayout:
      "This book has a fixed layout: font size, font and line spacing do not apply. The theme still does.",
    actionFailed: (detail: string) => `Could not update the book view: ${detail}`,
  },
  settings: {
    title: "Settings",
    open: "Settings",
    close: "Close",
    loading: "Loading settings…",
    loadFailed: (detail: string) => `Could not load settings: ${detail}`,
    retry: "Retry",
    languageSection: "Interface language",
    languageDescription:
      "The interface language is independent of the translation target language. Changing it reloads the page.",
    english: "English",
    chinese: "简体中文",
    applyLanguage: "Save language and reload",
    applyingLanguage: "Saving language…",
    languageFailed: (detail: string) => `Could not change the language: ${detail}`,
    languageBlocked: "The language cannot be applied right now.",
    languageBlockedActive: "Finish or cancel queued and running translation tasks.",
    languageBlockedUnsaved: "Retry saving, export, or discard unsaved translation drafts.",
    languageBlockedModified: "Save an edited copy, export, or discard the PDF edits.",
    languageBlockedPreview: "Add the current PDF to the library first.",
    languageBlockedSaving: "Wait for the edited copy to finish saving.",
    languageBlockedOutline:
      "Finish or cancel the outline generation and save or discard the outline first.",
    languageBlockedOutlineUnsaved:
      "Retry saving the outline or discard it first.",
    languageBlockedAuth: "Finish or cancel the AI sign-in first.",
    languageBlockedDirty: "Save or discard the AI form changes first.",
    aiSection: "AI provider and model",
    statusNone: "AI is not set up yet. Choose a provider and a vision model.",
    statusUnsaved: "Your current selection is not saved yet.",
    statusReady: (provider: string, model: string) => `Ready: ${provider} · ${model}`,
    statusIncomplete: "Saved, but setup is not finished",
    advanced: "Advanced settings",
    done: "Done",
    provider: "Provider",
    model: "Vision model",
    reasoningEffort: "Reasoning effort",
    reasoningEffortDefault: "Default (no override)",
    reasoningEffortUnavailable: "This model has no configurable reasoning effort.",
    reasoningEffortCustomNote: "Support depends on the custom endpoint.",
    reasoningEffortLevels: {
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Maximum",
    },
    chooseProvider: "Select a provider",
    chooseModel: "Select a vision model",
    baseUrl: "Endpoint override (optional)",
    baseUrlCustom: "Base URL",
    contextWindow: "Context window",
    maxTokens: "Maximum output tokens",
    saveConfig: "Save AI settings",
    savingConfig: "Saving…",
    configSaved: "Saved. New translation requests will use this configuration.",
    configSaveFailed: (detail: string) => `Could not save AI settings: ${detail}`,
    configInvalid:
      "Check the endpoint, token limits and reasoning effort, then try again.",
    refreshModels: "Refresh models",
    refreshingModels: "Refreshing models…",
    refreshFailed: (detail: string) => `Could not refresh models: ${detail}`,
    refreshed: "Model list refreshed.",
    noModels:
      "This provider has no image-capable model here. Sign in, then refresh models, or choose another provider.",
    noProviders: "No providers are available.",
    customNote:
      "Custom endpoints require a base URL and both token limits. A local endpoint may work without a key.",
    builtinNote:
      "The endpoint override is optional and only applies to this saved configuration.",
    modelListEmpty: "No image-capable models are listed for this provider.",
    authSection: "Authentication",
    authProvider: (name: string) => `Credential for ${name}`,
    authNone: "No stored credential. Translation cannot use this provider until you sign in.",
    authConfigured: (type: string) => `Stored credential: ${type}.`,
    authUnverified: "Stored credentials are used as saved; Lumo does not verify them with a live request.",
    apiKeyName: "API key",
    oauthName: "OAuth sign-in",
    addKey: "Configure API key",
    replaceKey: "Replace API key",
    signIn: "Sign in with OAuth",
    removeCredential: "Remove credential",
    signOut: "Sign out",
    credentialRemoved: "Credential removed.",
    credentialRemoveFailed: (detail: string) => `Could not remove the credential: ${detail}`,
    providerDefaultEndpoint: "the provider default endpoint",
    keylessNote:
      "A custom local endpoint may work without a key. Saving or opening Settings never sends a paid request.",
    loginStarting: "Starting sign-in…",
    loginWaiting: "Waiting for the provider…",
    loginActive: "Sign-in in progress",
    loginCancel: "Cancel sign-in",
    loginDone: "Signed in. The credential was saved.",
    loginCancelled: "Sign-in cancelled.",
    loginFailed: (detail: string) => `Sign-in failed: ${detail}`,
    loginExpired: "Sign-in expired. Start again.",
    loginBusy: "Another sign-in is already running.",
    promptLabel: "Provider instructions (original)",
    promptText: "Answer",
    promptSecret: "Secret value",
    promptManualCode: "Authorization code or callback URL",
    promptSubmit: "Submit",
    promptChoose: "Choose",
    promptExpired: "This prompt has expired.",
    notificationInfo: "Provider message",
    notificationProgress: "Provider status",
    deviceCodeLabel: "Verification code",
    deviceCodeAddress: "Verification address",
    authLink: "Open authorization link",
    openLink: "Open link",
    insecureLink: "This link is not HTTPS or loopback HTTP; it was not opened.",
    instructionsOriginal: "Original provider instructions",
    providerContentNote:
      "Provider prompts and authorization pages can remain in their original language.",
    unsavedForm: "You have unsaved AI settings changes.",
    dataSection: "Data and backups",
    dataDirectory: "Data directory:",
    backup:
      "Reading data and translations are stored in reader.sqlite. Backups are not encrypted at rest. Close every instance before copying the directory, including its WAL files; backups contain the AI credential database.",
    access:
      "The access code is valid only for this run. After a restart, open Lumo again from its window or use the new link printed in the terminal.",
    signOutNote:
      "Signing out removes the credential locally; it does not revoke it at the provider. Old backups can still contain it.",
  },
  launcher: {
    version: (version: string) => `Version ${version}`,
    statusStarting: "Starting the local service…",
    statusRunning: "Lumo is running",
    statusStopping: "Stopping the local service…",
    statusFailed: "Lumo is not running",
    addressLabel: "Local address",
    addressPending: "Not available yet",
    addressNote:
      "This address works only on this computer. The buttons below add the access code for this run.",
    open: "Open WebUI",
    copy: "Copy access link",
    copyNote:
      "The copied link includes this run's access code. Paste it only into a browser on this computer and do not share it.",
    retry: "Retry start",
    quit: "Quit Lumo",
    recent: "Recent activity",
    noActivity: "Nothing yet.",
    details: "More logs and details",
    allActivity: "All activity",
    dataDirectory: "Data directory",
    failureCode: "Failure code",
    quitTitle: "Quit Lumo?",
    quitBody:
      "Quitting stops the local service and interrupts translations in progress. Save any unsaved work in the WebUI first.",
    quitBack: "Go back",
    quitConfirm: "Quit Lumo",
    ipcFailed:
      "This window could not reach the Lumo launcher. Quit Lumo and open it again.",
    logs: {
      starting: "Starting Lumo…",
      reader_ready: "Library database opened.",
      assets_ready: "Reader and Typst components are ready.",
      credentials_ready: "Credential store opened.",
      ready: "Lumo is ready. Press “Open WebUI” to start reading.",
      stopping: "Stopping the local service…",
      browser_opened: "Opened the WebUI in your default browser.",
      browser_open_failed:
        "Could not open your browser. Use “Copy access link” and paste it into a browser.",
      link_copied: "Access link copied.",
      clipboard_failed:
        "Could not copy the link. Try again, or press “Open WebUI”.",
      sidecar_missing:
        "The Lumo service files are missing or cannot start. Reinstall Lumo.",
      protocol_failed:
        "The service sent something unexpected and was stopped. Retry; if it repeats, reinstall Lumo.",
      startup_timeout: "The service was not ready after 45 seconds and was stopped. Retry.",
      server_exited: "The service stopped unexpectedly. Retry to start it again.",
      shutdown_timeout: "The service did not stop in time and was ended.",
      DATA_DIRECTORY_INVALID:
        "The data directory setting is invalid. LUMO_DATA_DIR must be an absolute path.",
      READER_DATABASE_FAILED:
        "Could not open the library database. Check that the data directory is writable and the database is from a supported version.",
      PDFJS_ASSETS_FAILED:
        "The PDF viewer files are missing or damaged. Reinstall Lumo.",
      TYPST_ASSETS_FAILED:
        "The Typst preview files are missing or damaged. Reinstall Lumo.",
      CREDENTIALS_DATABASE_FAILED:
        "Could not open the AI credential database. Close other Lumo windows and check the data directory.",
      SERVER_LISTEN_FAILED:
        "Could not start the local server. Check that connections on this computer are allowed.",
      CONTROL_PROTOCOL_INVALID:
        "The launcher and the service disagreed on a command. Retry.",
    } satisfies Record<LauncherLogCode, string>,
  },
};

export type Messages = typeof en;
