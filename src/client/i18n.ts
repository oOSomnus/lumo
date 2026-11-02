import { useSyncExternalStore } from "react";
import { uiLocaleSchema, type UiLocale } from "../shared/contracts";
import { en, type ErrorMessage, type Messages } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export interface UiError {
  code: string;
  detail?: string;
  params?: Record<string, string | number>;
  status?: number;
}

export type { Messages };

const catalogs: Record<UiLocale, Messages> = { en, "zh-CN": zhCN };

let currentLocale: UiLocale = "en";
const listeners = new Set<() => void>();

export function getUiLocale(): UiLocale {
  return currentLocale;
}

export function applyDocumentLocale(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = currentLocale;
  document.title = catalogs[currentLocale].appTitle;
}

export function setUiLocale(next: UiLocale): void {
  if (!uiLocaleSchema.safeParse(next).success || next === currentLocale) {
    return;
  }
  currentLocale = next;
  applyDocumentLocale();
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useI18n(): { locale: UiLocale; t: Messages } {
  const locale = useSyncExternalStore(
    subscribe,
    getUiLocale,
    () => "en" as const,
  );
  return { locale, t: catalogs[locale] };
}

function numericParams(
  value: unknown,
): Record<string, string | number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const params: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number") {
      params[key] = entry;
    }
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

export function toUiError(error: unknown): UiError {
  if (!error || typeof error !== "object") {
    return error === undefined || error === null
      ? { code: "UNKNOWN" }
      : { code: "UNKNOWN", detail: String(error) };
  }
  const candidate = error as {
    code?: unknown;
    detail?: unknown;
    message?: unknown;
    params?: unknown;
    status?: unknown;
    name?: unknown;
  };
  const params = numericParams(candidate.params);
  if (typeof candidate.code === "string") {
    const detail =
      typeof candidate.detail === "string"
        ? candidate.detail
        : typeof candidate.message === "string"
          ? candidate.message
          : undefined;
    return {
      code: candidate.code,
      ...(detail ? { detail } : {}),
      ...(params ? { params } : {}),
      ...(typeof candidate.status === "number" ? { status: candidate.status } : {}),
    };
  }
  if (candidate.name === "AbortError") return { code: "ABORTED" };
  return {
    code: "UNKNOWN",
    ...(typeof candidate.message === "string"
      ? { detail: candidate.message }
      : {}),
  };
}

export function errorText(
  error: UiError,
  locale: UiLocale = currentLocale,
): string {
  const messages = catalogs[locale];
  const errors: Record<string, ErrorMessage> = messages.errors;
  const entry = errors[error.code] ?? errors.UNKNOWN!;
  const primary = entry(error.params ?? {});
  if (!error.detail || error.detail.trim() === "") return primary;
  return `${primary} (${error.detail})`;
}

const dateTimeFormats = new Map<UiLocale, Intl.DateTimeFormat>();

export function formatDateTime(locale: UiLocale, timestamp: number): string {
  let format = dateTimeFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      hour12: false,
    });
    dateTimeFormats.set(locale, format);
  }
  return format.format(timestamp);
}
