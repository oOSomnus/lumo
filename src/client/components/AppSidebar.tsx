import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import {
  BookOpenIcon,
  FilePlusIcon,
  LibraryIcon,
  SettingsIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
} from "../icons";
import { Brand } from "./Brand";

export type AppScreen = "library" | "reader" | "settings";

interface AppSidebarProps {
  screen: AppScreen;
  /** The open book's name, or null while nothing is open. */
  readingTitle: string | null;
  /** Icons only: always while reading, otherwise as the user left it. */
  compact: boolean;
  /** The collapse button is offered outside the reader, where the choice is remembered. */
  collapsible: boolean;
  onToggleCompact: () => void;
  onLibrary: () => void;
  onReading: () => void;
  onSettings: () => void;
  onOpenFile: () => void;
}

function NavItem({
  current,
  disabled = false,
  compact,
  label,
  detail,
  icon,
  onClick,
}: {
  current: boolean;
  disabled?: boolean;
  compact: boolean;
  label: string;
  detail?: string | null;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="sidebar-item"
      aria-current={current ? "page" : undefined}
      disabled={disabled}
      title={compact ? (detail ? `${label} · ${detail}` : label) : (detail ?? undefined)}
      onClick={onClick}
    >
      {icon}
      <span className="sidebar-item-text">
        <span>{label}</span>
        {detail && <span className="sidebar-item-detail">{detail}</span>}
      </span>
    </button>
  );
}

/** The app's main navigation: a sidebar on wide windows and a bottom tab bar on narrow ones. */
export function AppSidebar({
  screen,
  readingTitle,
  compact,
  collapsible,
  onToggleCompact,
  onLibrary,
  onReading,
  onSettings,
  onOpenFile,
}: AppSidebarProps) {
  const { t } = useI18n();
  const toggleLabel = compact ? t.appBar.expandSidebar : t.appBar.collapseSidebar;
  return (
    <nav className={compact ? "app-sidebar compact" : "app-sidebar"} aria-label={t.appBar.navigation}>
      <Brand compact={compact} />
      <div className="sidebar-nav">
        <NavItem
          current={screen === "library"}
          compact={compact}
          label={t.appBar.library}
          icon={<LibraryIcon />}
          onClick={onLibrary}
        />
        <NavItem
          current={screen === "reader"}
          disabled={readingTitle === null}
          compact={compact}
          label={t.appBar.reading}
          detail={readingTitle}
          icon={<BookOpenIcon />}
          onClick={onReading}
        />
        <NavItem
          current={screen === "settings"}
          compact={compact}
          label={t.appBar.settings}
          icon={<SettingsIcon />}
          onClick={onSettings}
        />
      </div>
      <span className="sidebar-spacer" />
      <button
        type="button"
        className={compact ? "sidebar-open ghost" : "sidebar-open primary"}
        title={compact ? t.appBar.openPdf : undefined}
        onClick={onOpenFile}
      >
        <FilePlusIcon />
        <span className="sidebar-open-label">{t.appBar.openPdf}</span>
      </button>
      {collapsible && (
        <button
          type="button"
          className="sidebar-toggle icon-button ghost"
          aria-label={toggleLabel}
          aria-expanded={!compact}
          title={toggleLabel}
          onClick={onToggleCompact}
        >
          {compact ? <SidebarExpandIcon /> : <SidebarCollapseIcon />}
        </button>
      )}
    </nav>
  );
}
