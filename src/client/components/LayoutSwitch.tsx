import { useI18n, type Messages } from "../i18n";

/** Which panes are on screen: both side by side, or only the original (left) or the translation (right). */
export type PaneMode = "both" | "left" | "right";

interface Preset {
  label: Exclude<keyof Messages["layout"], "label">;
  mode: PaneMode;
  /** The left pane's share of the width; a single pane has none. */
  ratio?: number;
}

const PRESETS: readonly Preset[] = [
  { label: "leftOnly", mode: "left" },
  { label: "rightOnly", mode: "right" },
  { label: "equal", mode: "both", ratio: 0.5 },
  { label: "leftWide", mode: "both", ratio: 0.6 },
  { label: "rightWide", mode: "both", ratio: 0.4 },
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
      {PRESETS.map((preset) => (
        <button
          key={preset.label}
          type="button"
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
