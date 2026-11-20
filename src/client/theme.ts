import { useSyncExternalStore } from "react";
import { UI_THEMES, type ColorTheme, type UiTheme } from "../shared/contracts";
import { colorSchemeOf } from "./reading-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** `system` follows the operating system's light or dark preference; every other choice is itself. */
export function resolveTheme(preference: UiTheme, systemDark: boolean): ColorTheme {
  if (preference !== "system") return preference;
  return systemDark ? "dark" : "light";
}

/** Paints a document with a theme: `data-theme` selects the palette in styles.css. */
export function applyColorTheme(root: HTMLElement, theme: ColorTheme): void {
  root.dataset.theme = theme;
  root.style.colorScheme = colorSchemeOf(theme);
}

export interface ThemeState {
  preference: UiTheme;
  theme: ColorTheme;
}

const media = typeof matchMedia === "function" ? matchMedia(DARK_QUERY) : null;
let state: ThemeState = {
  preference: "system",
  theme: resolveTheme("system", media?.matches ?? false),
};
const listeners = new Set<() => void>();

function update(preference: UiTheme): void {
  const theme = resolveTheme(preference, media?.matches ?? false);
  if (preference === state.preference && theme === state.theme) return;
  state = { preference, theme };
  if (typeof document !== "undefined") applyColorTheme(document.documentElement, theme);
  for (const listener of [...listeners]) listener();
}

if (typeof document !== "undefined") applyColorTheme(document.documentElement, state.theme);
media?.addEventListener("change", () => update(state.preference));

export function getThemeState(): ThemeState {
  return state;
}

/** Shows a theme choice at once; saving it is the caller's job. */
export function setThemePreference(next: UiTheme): void {
  if (!(UI_THEMES as readonly string[]).includes(next)) return;
  update(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The stored choice and the theme it resolves to now. */
export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, getThemeState, getThemeState);
}
