import { useI18n, type Messages } from "../i18n";
import type { LayoutPreset } from "../page-keys";

/** Which panes are on screen: both side by side, or only the original (left) or the translation (right). */
export type PaneMode = "both" | "left" | "right";

export interface LayoutPresetEntry {
  /** The number key that applies this layout. */
  preset: LayoutPreset;
  label: Exclude<keyof Messages["layout"], "label">;
  mode: PaneMode;
  /** The left pane's share of the width; a single pane has none. */
  ratio?: number;
}

/** The five layouts, in shortcut order. */
export const LAYOUT_PRESETS: readonly LayoutPresetEntry[] = [
  { preset: 1, label: "leftOnly", mode: "left" },
  { preset: 2, label: "rightOnly", mode: "right" },
  { preset: 3, label: "equal", mode: "both", ratio: 0.5 },
  { preset: 4, label: "leftWide", mode: "both", ratio: 0.6 },
  { preset: 5, label: "rightWide", mode: "both", ratio: 0.4 },
];

interface LayoutSwitchProps {
  mode: PaneMode;
  ratio: number;
  onChange: (mode: PaneMode, ratio?: number) => void;
}

export function LayoutSwitch({ mode, ratio, onChange }: LayoutSwitchProps) {
  const { t } = useI18n();
  return (
    <div className="layout-switch" role="group" aria-label={t.layout.label}>
      {LAYOUT_PRESETS.map((preset) => (
        <button
          key={preset.preset}
          type="button"
          title={t.layout[preset.label]}
          aria-keyshortcuts={`Control+${preset.preset} Control+Shift+${preset.preset}`}
          aria-pressed={
            preset.mode === mode &&
            (preset.ratio === undefined || Math.abs(ratio - preset.ratio) < 1e-6)
          }
          onClick={() => onChange(preset.mode, preset.ratio)}
        >
          {t.layout[preset.label]}
        </button>
      ))}
    </div>
  );
}
