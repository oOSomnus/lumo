//! Launcher state and the line protocol spoken by the `--desktop` server.
//!
//! Nothing here touches Tauri or processes, so the lifecycle rules can be tested directly.
//! The access link (which carries the one-run access code) lives only in [`State`]; a
//! [`Snapshot`] never contains it.

use std::collections::VecDeque;
use std::fmt;

use serde::{Deserialize, Serialize};
use url::Url;

pub const LOG_LIMIT: usize = 200;
pub const STARTUP_TIMEOUT_SECS: u64 = 45;
const STARTUP_TIMEOUT_MS: u64 = STARTUP_TIMEOUT_SECS * 1000;
pub const SHUTDOWN_TIMEOUT_SECS: u64 = 35;
const SHUTDOWN_TIMEOUT_MS: u64 = SHUTDOWN_TIMEOUT_SECS * 1000;
pub const SHUTDOWN_COMMAND: &[u8] = b"{\"type\":\"shutdown\"}\n";

const ACCESS_LINE_PREFIX: &str = "Open in your browser: ";

const SERVER_LOG_CODES: &[&str] = &[
    "starting",
    "reader_upgraded",
    "reader_ready",
    "assets_ready",
    "credentials_ready",
    "stopping",
];
const SERVER_FAILURE_CODES: &[&str] = &[
    "DATA_DIRECTORY_INVALID",
    "READER_DATABASE_FAILED",
    UPGRADE_REQUIRED_CODE,
    "PDFJS_ASSETS_FAILED",
    "TYPST_ASSETS_FAILED",
    "CREDENTIALS_DATABASE_FAILED",
    "SERVER_LISTEN_FAILED",
    "CONTROL_PROTOCOL_INVALID",
];
/// The reader database uses the previous schema; only the user may agree to upgrade it.
const UPGRADE_REQUIRED_CODE: &str = "READER_DATABASE_UPGRADE_REQUIRED";
/// The server argument that carries that agreement.
pub const UPGRADE_DATABASE_ARG: &str = "--upgrade-database";
const UI_LOCALES: &[&str] = &["en", "zh-CN"];
const UI_THEMES: &[&str] = &["system", "light", "dark", "sepia", "night"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    Disabled,
    #[default]
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Ready,
    Installing,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallMode {
    #[default]
    InApp,
    Download,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateError {
    CheckFailed,
    DownloadFailed,
    ShutdownFailed,
    InstallFailed,
}

/// The panel's update contract; it never contains a plugin object or downloaded bytes.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateState {
    pub phase: UpdatePhase,
    pub version: Option<String>,
    pub install_mode: InstallMode,
    pub error_code: Option<UpdateError>,
}

/// When the launcher saw something: wall-clock time for the activity log, and monotonic time
/// (unaffected by clock changes) for the startup and shutdown deadlines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Moment {
    pub wall_ms: u64,
    pub monotonic_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    pub at: u64,
    pub level: Level,
    pub code: &'static str,
}

/// The browser link including its access code. Never serialized, never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct AccessLink {
    full: String,
    base: String,
}

impl fmt::Debug for AccessLink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "AccessLink({})", self.base)
    }
}

impl AccessLink {
    /// Accepts exactly `http://127.0.0.1:<port>/?token=<code>`.
    fn parse(text: &str) -> Option<Self> {
        let url = Url::parse(text.trim()).ok()?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return None;
        }
        let port = url.port().filter(|port| *port != 0)?;
        let mut pairs = url.query_pairs();
        let (key, value) = pairs.next()?;
        if key != "token" || value.is_empty() || pairs.next().is_some() {
            return None;
        }
        Some(Self {
            full: url.to_string(),
            base: format!("http://127.0.0.1:{port}/"),
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    Log(&'static str),
    Preferences {
        ui_locale: &'static str,
        theme: &'static str,
    },
    Ready {
        data_directory: String,
    },
    Failed(&'static str),
    Stopped,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    Access(AccessLink),
    Event(Event),
    /// Ordinary server output; not part of the protocol.
    Ignored,
    /// Looked like protocol but is not valid.
    Invalid,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WireEvent {
    Log {
        code: String,
    },
    Preferences {
        #[serde(rename = "uiLocale")]
        ui_locale: String,
        theme: String,
    },
    Ready {
        #[serde(rename = "dataDirectory")]
        data_directory: String,
    },
    Failed {
        code: String,
    },
    Stopped,
}

fn known(list: &'static [&'static str], code: &str) -> Option<&'static str> {
    list.iter().copied().find(|known| *known == code)
}

pub fn parse_line(line: &str) -> Parsed {
    let line = line.trim_end_matches(['\r', '\n']);
    if let Some(rest) = line.strip_prefix(ACCESS_LINE_PREFIX) {
        return AccessLink::parse(rest).map_or(Parsed::Invalid, Parsed::Access);
    }
    if !line.starts_with('{') {
        return Parsed::Ignored;
    }
    let Ok(wire) = serde_json::from_str::<WireEvent>(line) else {
        return Parsed::Invalid;
    };
    let event = match wire {
        WireEvent::Log { code } => known(SERVER_LOG_CODES, &code).map(Event::Log),
        WireEvent::Failed { code } => known(SERVER_FAILURE_CODES, &code).map(Event::Failed),
        WireEvent::Stopped => Some(Event::Stopped),
        WireEvent::Preferences { ui_locale, theme } => known(UI_LOCALES, &ui_locale)
            .zip(known(UI_THEMES, &theme))
            .map(|(ui_locale, theme)| Event::Preferences { ui_locale, theme }),
        WireEvent::Ready { data_directory } => (!data_directory.is_empty())
            .then_some(Event::Ready { data_directory }),
    };
    event.map_or(Parsed::Invalid, Parsed::Event)
}

/// What the panel may see. `web_ui_url` is the address without the access code.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub version: &'static str,
    pub phase: Phase,
    pub web_ui_url: Option<String>,
    pub data_directory: Option<String>,
    pub ui_locale: Option<&'static str>,
    pub theme: Option<&'static str>,
    pub failure_code: Option<&'static str>,
    pub can_retry: bool,
    pub can_upgrade: bool,
    pub update: LauncherUpdateState,
    pub logs: Vec<LogEntry>,
}

/// What a startup or shutdown watchdog does next for the run it watches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchdogCheck {
    /// The run is no longer in the watched phase, or was replaced: stop watching.
    Settled,
    /// The run ran out of time: end its process.
    Overdue,
    /// Look again after this many milliseconds.
    Wait(u64),
}

#[derive(Debug, PartialEq, Eq)]
pub enum LineOutcome {
    Unchanged,
    Changed,
    /// The server broke the protocol: it has been marked failed and must be killed.
    ProtocolViolation,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Termination {
    /// Not the current process, or nothing to update.
    Ignored,
    /// The process ended; the launcher state moved to failed.
    Failed,
    /// The process ended because the user asked to quit.
    Quit,
    /// The server stopped cleanly for an update; the launcher may install it now.
    UpdateReady,
    /// The server did not stop cleanly for the update; nothing may be installed.
    UpdateAborted,
}

/// Why the launcher is stopping the server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopPurpose {
    Quit,
    Update,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StopPlan {
    AlreadyStopping,
    /// No server process to wait for.
    ExitNow,
    /// Send the shutdown command and watch for this process to end in time.
    SendShutdown { generation: u64 },
}

/// What the adapter does with the checked update after a check completes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckResourcePlan {
    KeepAvailable,
    ClearAvailable,
    StoreAvailable,
}

/// What the adapter does with the verified bytes after a download completes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DownloadResourcePlan {
    KeepAvailable,
    StorePending,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum UpdateStatus {
    Disabled,
    Idle,
    Checking,
    Current,
    Available(String),
    Downloading(String),
    Ready(String),
    Installing(Option<String>),
    Failed {
        version: Option<String>,
        error: UpdateError,
    },
}

struct UpdateLifecycle {
    enabled: bool,
    mode: InstallMode,
    checking: bool,
    downloading: bool,
    installing: bool,
    status: UpdateStatus,
}

impl UpdateLifecycle {
    fn snapshot(&self, version: &'static str) -> LauncherUpdateState {
        let current = || Some(version.to_owned());
        let (phase, reported, error_code) = match &self.status {
            UpdateStatus::Disabled => (UpdatePhase::Disabled, None, None),
            UpdateStatus::Idle => (UpdatePhase::Idle, current(), None),
            UpdateStatus::Checking => (UpdatePhase::Checking, current(), None),
            UpdateStatus::Current => (UpdatePhase::Current, current(), None),
            UpdateStatus::Available(offered) => {
                (UpdatePhase::Available, Some(offered.clone()), None)
            }
            UpdateStatus::Downloading(offered) => {
                (UpdatePhase::Downloading, Some(offered.clone()), None)
            }
            UpdateStatus::Ready(offered) => (UpdatePhase::Ready, Some(offered.clone()), None),
            UpdateStatus::Installing(installing) => {
                (UpdatePhase::Installing, installing.clone(), None)
            }
            UpdateStatus::Failed { version, error } => {
                (UpdatePhase::Failed, version.clone(), Some(*error))
            }
        };
        LauncherUpdateState {
            phase,
            version: reported,
            install_mode: self.mode,
            error_code,
        }
    }
}

pub struct State {
    version: &'static str,
    revision: u64,
    generation: u64,
    phase: Phase,
    process_alive: bool,
    link: Option<AccessLink>,
    data_directory: Option<String>,
    /// The library's language and theme as last reported; kept across runs.
    ui_locale: Option<&'static str>,
    theme: Option<&'static str>,
    failure_code: Option<&'static str>,
    update: UpdateLifecycle,
    exit_allowed: bool,
    stop_purpose: Option<StopPurpose>,
    stop_confirmed: bool,
    /// An approved database upgrade is running; its backup and migration have no deadline.
    upgrade_pending: bool,
    /// When an upgrade run's reader database opened, in monotonic milliseconds; the ordinary
    /// startup and shutdown deadlines count from here.
    reader_opened_at: Option<u64>,
    logs: VecDeque<LogEntry>,
}

impl State {
    pub fn new(version: &'static str, enabled: bool, mode: InstallMode) -> Self {
        Self {
            version,
            revision: 0,
            generation: 0,
            phase: Phase::Starting,
            process_alive: false,
            link: None,
            data_directory: None,
            ui_locale: None,
            theme: None,
            failure_code: None,
            update: UpdateLifecycle {
                enabled,
                mode,
                checking: false,
                downloading: false,
                installing: false,
                status: UpdateStatus::Disabled,
            },
            exit_allowed: false,
            stop_purpose: None,
            stop_confirmed: false,
            upgrade_pending: false,
            reader_opened_at: None,
            logs: VecDeque::new(),
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            revision: self.revision,
            version: self.version,
            phase: self.phase,
            web_ui_url: self.link.as_ref().map(|link| link.base.clone()),
            data_directory: self.data_directory.clone(),
            ui_locale: self.ui_locale,
            theme: self.theme,
            failure_code: self.failure_code,
            can_retry: self.can_retry(),
            can_upgrade: self.can_upgrade(),
            update: self.update.snapshot(self.version),
            logs: self.logs.iter().cloned().collect(),
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    fn can_retry(&self) -> bool {
        self.phase == Phase::Failed && !self.process_alive
    }

    fn can_upgrade(&self) -> bool {
        self.can_retry() && self.failure_code == Some(UPGRADE_REQUIRED_CODE)
    }

    /// The full link, only while the server is running.
    pub fn open_target(&self) -> Option<&str> {
        match (self.phase, &self.link) {
            (Phase::Running, Some(link)) => Some(&link.full),
            _ => None,
        }
    }

    fn push(&mut self, at: u64, level: Level, code: &'static str) {
        if self.logs.len() == LOG_LIMIT {
            self.logs.pop_front();
        }
        self.logs.push_back(LogEntry { at, level, code });
        self.revision += 1;
    }

    fn fail(&mut self, at: u64, code: &'static str) {
        self.phase = Phase::Failed;
        self.link = None;
        self.failure_code = Some(code);
        self.push(at, Level::Error, code);
    }

    /// Starts a fresh run. Refused while a previous process may still be alive, so a retry
    /// can never produce a second server. Returns the run's generation.
    pub fn begin_start(&mut self) -> Option<u64> {
        if self.process_alive || !matches!(self.phase, Phase::Starting | Phase::Failed) {
            return None;
        }
        self.generation += 1;
        self.phase = Phase::Starting;
        self.process_alive = true;
        self.link = None;
        self.data_directory = None;
        self.failure_code = None;
        self.stop_purpose = None;
        self.stop_confirmed = false;
        self.upgrade_pending = false;
        self.reader_opened_at = None;
        self.revision += 1;
        Some(self.generation)
    }

    /// Starts a run that upgrades the reader database, only after the server asked for that
    /// agreement and its process has ended.
    pub fn begin_upgrade(&mut self) -> Option<u64> {
        if !self.can_upgrade() {
            return None;
        }
        let generation = self.begin_start()?;
        self.upgrade_pending = true;
        Some(generation)
    }

    /// The process could not be spawned at all.
    pub fn spawn_failed(&mut self, at: u64, code: &'static str) {
        self.process_alive = false;
        self.fail(at, code);
    }

    /// Records the end of an approved upgrade when the reader database is open, upgraded or
    /// found current. False for every other line.
    fn note_reader_opened(&mut self, at: Moment, code: &'static str) -> bool {
        if !self.upgrade_pending || !matches!(code, "reader_upgraded" | "reader_ready") {
            return false;
        }
        self.upgrade_pending = false;
        self.reader_opened_at = Some(at.monotonic_ms);
        true
    }

    pub fn on_line(&mut self, at: Moment, generation: u64, line: &str) -> LineOutcome {
        if generation != self.generation || !self.process_alive {
            return LineOutcome::Unchanged;
        }
        let parsed = parse_line(line);
        match (self.phase, parsed) {
            (_, Parsed::Ignored) => LineOutcome::Unchanged,
            // Output after failing or while quitting is not acted on; the update path still needs
            // the server's stopped acknowledgement before it may install.
            (Phase::Failed, _) => LineOutcome::Unchanged,
            (Phase::Stopping, Parsed::Event(Event::Stopped)) => {
                self.stop_confirmed = true;
                self.revision += 1;
                LineOutcome::Changed
            }
            // A stop during an approved upgrade waits for the database; the shutdown deadline
            // counts from when it opened.
            (Phase::Stopping, Parsed::Event(Event::Log(code)))
                if self.note_reader_opened(at, code) =>
            {
                self.push(at.wall_ms, Level::Info, code);
                LineOutcome::Changed
            }
            (Phase::Stopping, _) => LineOutcome::Unchanged,
            (_, Parsed::Invalid) => self.violation(at.wall_ms),
            (Phase::Starting, Parsed::Access(link)) if self.link.is_none() => {
                self.link = Some(link);
                self.revision += 1;
                LineOutcome::Changed
            }
            (_, Parsed::Access(_)) => self.violation(at.wall_ms),
            (_, Parsed::Event(Event::Log(code))) => {
                self.note_reader_opened(at, code);
                self.push(at.wall_ms, Level::Info, code);
                LineOutcome::Changed
            }
            (Phase::Starting, Parsed::Event(Event::Preferences { ui_locale, theme })) => {
                self.ui_locale = Some(ui_locale);
                self.theme = Some(theme);
                self.revision += 1;
                LineOutcome::Changed
            }
            (_, Parsed::Event(Event::Preferences { .. })) => self.violation(at.wall_ms),
            (Phase::Starting, Parsed::Event(Event::Ready { data_directory }))
                if self.link.is_some() =>
            {
                self.phase = Phase::Running;
                self.data_directory = Some(data_directory);
                self.push(at.wall_ms, Level::Info, "ready");
                LineOutcome::Changed
            }
            (_, Parsed::Event(Event::Ready { .. })) => self.violation(at.wall_ms),
            (_, Parsed::Event(Event::Failed(code))) => {
                self.fail(at.wall_ms, code);
                LineOutcome::Changed
            }
            (_, Parsed::Event(Event::Stopped)) => LineOutcome::Unchanged,
        }
    }

    fn violation(&mut self, at: u64) -> LineOutcome {
        self.fail(at, "protocol_failed");
        LineOutcome::ProtocolViolation
    }

    pub fn on_terminated(&mut self, at: u64, generation: u64, success: bool) -> Termination {
        if generation != self.generation || !self.process_alive {
            return Termination::Ignored;
        }
        self.process_alive = false;
        match self.phase {
            Phase::Stopping => {
                self.revision += 1;
                let purpose = self.stop_purpose.take();
                if purpose == Some(StopPurpose::Update) {
                    let confirmed = self.stop_confirmed;
                    self.stop_confirmed = false;
                    if success && confirmed {
                        Termination::UpdateReady
                    } else {
                        self.phase = Phase::Failed;
                        self.link = None;
                        Termination::UpdateAborted
                    }
                } else {
                    self.stop_confirmed = false;
                    Termination::Quit
                }
            }
            Phase::Starting | Phase::Running => {
                self.fail(at, "server_exited");
                Termination::Failed
            }
            Phase::Failed => {
                self.revision += 1;
                Termination::Ignored
            }
        }
    }

    /// True when this run never became ready in time and must be killed.
    /// Checked by the startup watchdog, first after [`STARTUP_TIMEOUT_SECS`]. A normal run is
    /// overdue then. An approved upgrade waits while the server backs up and migrates the
    /// database, then gets the same deadline counted from when the database opened.
    pub fn startup_check(&mut self, at: Moment, generation: u64) -> WatchdogCheck {
        if generation != self.generation || !self.process_alive || self.phase != Phase::Starting {
            return WatchdogCheck::Settled;
        }
        if let Some(wait) = self.upgrade_wait(at, STARTUP_TIMEOUT_MS) {
            return WatchdogCheck::Wait(wait);
        }
        self.fail(at.wall_ms, "startup_timeout");
        WatchdogCheck::Overdue
    }

    /// More time for a run that is upgrading its database: the whole timeout while the upgrade
    /// runs, then what is left of it counted from when the database opened.
    fn upgrade_wait(&self, at: Moment, timeout_ms: u64) -> Option<u64> {
        if self.upgrade_pending {
            return Some(timeout_ms);
        }
        let deadline = self.reader_opened_at?.saturating_add(timeout_ms);
        (at.monotonic_ms < deadline).then(|| deadline - at.monotonic_ms)
    }

    pub fn begin_stop(&mut self, purpose: StopPurpose) -> StopPlan {
        if self.phase == Phase::Stopping {
            return StopPlan::AlreadyStopping;
        }
        self.phase = Phase::Stopping;
        self.link = None;
        self.stop_purpose = Some(purpose);
        self.stop_confirmed = false;
        self.revision += 1;
        if self.process_alive {
            StopPlan::SendShutdown {
                generation: self.generation,
            }
        } else {
            StopPlan::ExitNow
        }
    }

    /// Checked by the shutdown watchdog, first after [`SHUTDOWN_TIMEOUT_SECS`]. Overdue when the
    /// server ignored the shutdown request for too long and must be killed. The server reads
    /// the request only once an approved database upgrade is done, so that run waits for the
    /// upgrade and then gets the same deadline counted from when the database opened.
    pub fn shutdown_check(&mut self, at: Moment, generation: u64) -> WatchdogCheck {
        if generation != self.generation || !self.process_alive || self.phase != Phase::Stopping {
            return WatchdogCheck::Settled;
        }
        if let Some(wait) = self.upgrade_wait(at, SHUTDOWN_TIMEOUT_MS) {
            return WatchdogCheck::Wait(wait);
        }
        self.push(at.wall_ms, Level::Warn, "shutdown_timeout");
        WatchdogCheck::Overdue
    }

    /// Puts the panel at its starting point. True when the adapter should run the update loop.
    pub fn initialize_updates(&mut self) -> bool {
        let enabled = self.update.enabled;
        self.update.status = if enabled {
            UpdateStatus::Idle
        } else {
            UpdateStatus::Disabled
        };
        self.revision += 1;
        enabled
    }

    pub fn begin_update_check(&mut self, has_pending: bool) -> bool {
        let update = &mut self.update;
        if !update.enabled
            || update.checking
            || update.downloading
            || update.installing
            || has_pending
        {
            return false;
        }
        update.checking = true;
        update.status = UpdateStatus::Checking;
        self.revision += 1;
        true
    }

    pub fn finish_update_check(
        &mut self,
        result: Result<Option<String>, ()>,
    ) -> CheckResourcePlan {
        self.update.checking = false;
        if self.phase == Phase::Stopping {
            return CheckResourcePlan::ClearAvailable;
        }
        // A download or install admitted during the check owns the newer panel state.
        if !matches!(self.update.status, UpdateStatus::Checking) {
            return CheckResourcePlan::KeepAvailable;
        }
        match result {
            Ok(Some(version)) => {
                self.update.status = UpdateStatus::Available(version);
                self.revision += 1;
                CheckResourcePlan::StoreAvailable
            }
            Ok(None) => {
                self.update.status = UpdateStatus::Current;
                self.revision += 1;
                CheckResourcePlan::ClearAvailable
            }
            Err(()) => {
                self.update.status = UpdateStatus::Failed {
                    version: Some(self.version.to_owned()),
                    error: UpdateError::CheckFailed,
                };
                self.revision += 1;
                CheckResourcePlan::KeepAvailable
            }
        }
    }

    /// A download may start while a check is still running; only an active download or install blocks it.
    pub fn begin_update_download(
        &mut self,
        available_version: Option<&str>,
        has_pending: bool,
    ) -> bool {
        let update = &mut self.update;
        if !update.enabled || update.downloading || update.installing || has_pending {
            return false;
        }
        let Some(version) = available_version else {
            return false;
        };
        update.downloading = true;
        update.status = UpdateStatus::Downloading(version.to_owned());
        self.revision += 1;
        true
    }

    pub fn finish_update_download(
        &mut self,
        version: String,
        succeeded: bool,
    ) -> DownloadResourcePlan {
        self.update.downloading = false;
        if self.phase == Phase::Stopping {
            return DownloadResourcePlan::KeepAvailable;
        }
        if succeeded {
            self.update.status = UpdateStatus::Ready(version);
            self.revision += 1;
            DownloadResourcePlan::StorePending
        } else {
            self.update.status = UpdateStatus::Failed {
                version: Some(version),
                error: UpdateError::DownloadFailed,
            };
            self.revision += 1;
            DownloadResourcePlan::KeepAvailable
        }
    }

    /// The early install check, before acquiring the update resources.
    pub fn can_install_update(&self) -> bool {
        self.update.enabled
            && self.update.mode == InstallMode::InApp
            && self.phase != Phase::Stopping
    }

    pub fn begin_update_install(&mut self, pending_version: Option<&str>) -> bool {
        let update = &mut self.update;
        if update.installing {
            return false;
        }
        let Some(version) = pending_version else {
            return false;
        };
        update.installing = true;
        update.status = UpdateStatus::Installing(Some(version.to_owned()));
        self.revision += 1;
        true
    }

    pub fn show_update_installing(&mut self, version: Option<String>) {
        self.update.status = UpdateStatus::Installing(version);
        self.revision += 1;
    }

    /// The installer refused: its bytes are consumed, so a retry downloads again.
    pub fn finish_update_install(&mut self, version: Option<String>) {
        self.update.installing = false;
        self.update.status = UpdateStatus::Failed {
            version,
            error: UpdateError::InstallFailed,
        };
        self.revision += 1;
    }

    /// The sidecar did not stop cleanly; the verified bytes stay for another attempt.
    pub fn update_shutdown_failed(&mut self, version: Option<String>) {
        self.update.installing = false;
        self.update.status = UpdateStatus::Failed {
            version,
            error: UpdateError::ShutdownFailed,
        };
        self.revision += 1;
    }

    pub fn set_exit_allowed(&mut self, allowed: bool) {
        self.exit_allowed = allowed;
    }

    pub fn can_exit(&self) -> bool {
        self.exit_allowed
    }

    /// The release page to open, preferring what was already downloaded.
    pub fn update_download_version<'a>(
        &self,
        pending: Option<&'a str>,
        available: Option<&'a str>,
    ) -> Option<&'a str> {
        if self.update.mode != InstallMode::Download {
            return None;
        }
        pending.or(available)
    }

    /// An install could not start or finish: keep the launcher usable for a retry.
    pub fn update_install_failed(&mut self) {
        if self.phase == Phase::Stopping {
            self.phase = Phase::Failed;
            self.link = None;
            self.stop_purpose = None;
            self.revision += 1;
        }
    }

    /// Records a launcher-side action (browser, clipboard) in the activity log.
    pub fn note(&mut self, at: u64, level: Level, code: &'static str) {
        self.push(at, level, code);
    }
}

/// Takes the process held for `generation`, leaving any other run's process in place. The one
/// release path for killing and for termination, so a late call armed for an old run can never
/// stop or drop the process of a newer one.
pub fn take_run<T>(slot: &mut Option<(u64, T)>, generation: u64) -> Option<T> {
    slot.take_if(|(owner, _)| *owner == generation)
        .map(|(_, process)| process)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    const LINK: &str = "Open in your browser: http://127.0.0.1:43210/?token=11111111-2222-3333-4444-555555555555";
    const TOKEN: &str = "11111111-2222-3333-4444-555555555555";
    const PREFERENCES: &str = r#"{"type":"preferences","uiLocale":"zh-CN","theme":"night"}"#;
    const READY: &str = r#"{"type":"ready","dataDirectory":"/data/lumo"}"#;

    /// A moment whose wall clock and monotonic clock agree.
    fn at(ms: u64) -> Moment {
        Moment {
            wall_ms: ms,
            monotonic_ms: ms,
        }
    }

    fn started() -> (State, u64) {
        let mut state = State::new("9.9.9", false, InstallMode::Download);
        let generation = state.begin_start().expect("first start is allowed");
        (state, generation)
    }

    fn running() -> (State, u64) {
        let (mut state, generation) = started();
        assert_eq!(state.on_line(at(1), generation, PREFERENCES), LineOutcome::Changed);
        assert_eq!(state.on_line(at(1), generation, LINK), LineOutcome::Changed);
        assert_eq!(state.on_line(at(2), generation, READY), LineOutcome::Changed);
        assert_eq!(state.phase(), Phase::Running);
        (state, generation)
    }

    fn access(line: &str) -> bool {
        matches!(parse_line(line), Parsed::Access(_))
    }

    #[test]
    fn access_link_must_be_exactly_the_loopback_link_with_one_token() {
        assert!(access(LINK));
        for bad in [
            "http://127.0.0.1/?token=abc",
            "http://127.0.0.1:0/?token=abc",
            "https://127.0.0.1:43210/?token=abc",
            "http://localhost:43210/?token=abc",
            "http://192.168.1.5:43210/?token=abc",
            "http://[::1]:43210/?token=abc",
            "http://user@127.0.0.1:43210/?token=abc",
            "http://127.0.0.1:43210/other?token=abc",
            "http://127.0.0.1:43210/?token=",
            "http://127.0.0.1:43210/",
            "http://127.0.0.1:43210/?code=abc",
            "http://127.0.0.1:43210/?token=abc&token=def",
            "http://127.0.0.1:43210/?token=abc&extra=1",
            "http://127.0.0.1:43210/?token=abc#frag",
            "not a url",
        ] {
            assert!(
                !access(&format!("{ACCESS_LINE_PREFIX}{bad}")),
                "{bad} must be rejected"
            );
            assert_eq!(
                parse_line(&format!("{ACCESS_LINE_PREFIX}{bad}")),
                Parsed::Invalid
            );
        }
    }

    #[test]
    fn events_are_whitelisted_and_strict() {
        assert_eq!(
            parse_line(r#"{"type":"log","code":"reader_ready"}"#),
            Parsed::Event(Event::Log("reader_ready"))
        );
        assert_eq!(
            parse_line(r#"{"type":"failed","code":"SERVER_LISTEN_FAILED"}"#),
            Parsed::Event(Event::Failed("SERVER_LISTEN_FAILED"))
        );
        assert_eq!(parse_line(r#"{"type":"stopped"}"#), Parsed::Event(Event::Stopped));
        assert_eq!(
            parse_line(READY),
            Parsed::Event(Event::Ready {
                data_directory: "/data/lumo".into(),
            })
        );
        assert_eq!(
            parse_line(PREFERENCES),
            Parsed::Event(Event::Preferences {
                ui_locale: "zh-CN",
                theme: "night"
            })
        );
        for bad in [
            r#"{"type":"log","code":"made_up"}"#,
            r#"{"type":"failed","code":"made_up"}"#,
            r#"{"type":"log","code":"starting","extra":1}"#,
            r#"{"type":"ready","dataDirectory":""}"#,
            r#"{"type":"ready","dataDirectory":"/d","uiLocale":"en"}"#,
            r#"{"type":"preferences","uiLocale":"fr","theme":"dark"}"#,
            r#"{"type":"preferences","uiLocale":"en","theme":"blue"}"#,
            r#"{"type":"preferences","uiLocale":"en"}"#,
            r#"{"type":"explode"}"#,
            r#"{"code":"starting"}"#,
            r#"{broken"#,
        ] {
            assert_eq!(parse_line(bad), Parsed::Invalid, "{bad}");
        }
        for ordinary in [
            "Lumo data directory: /tmp/x",
            "PDF.js assets: /a",
            "",
            "AI translation: configure a provider, model and credentials in Settings.",
        ] {
            assert_eq!(parse_line(ordinary), Parsed::Ignored, "{ordinary}");
        }
    }

    #[test]
    fn a_ready_server_exposes_the_address_but_never_the_access_code() {
        let (state, _) = running();
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, Phase::Running);
        assert_eq!(snapshot.web_ui_url.as_deref(), Some("http://127.0.0.1:43210/"));
        assert_eq!(snapshot.ui_locale, Some("zh-CN"));
        assert_eq!(snapshot.theme, Some("night"));
        assert_eq!(snapshot.data_directory.as_deref(), Some("/data/lumo"));

        let wire = serde_json::to_string(&snapshot).unwrap();
        assert!(!wire.contains(TOKEN), "snapshot leaked the access code: {wire}");
        assert!(!wire.contains("token"));
        assert!(!format!("{:?}", state.link).contains(TOKEN));
        assert_eq!(
            state.open_target(),
            Some("http://127.0.0.1:43210/?token=11111111-2222-3333-4444-555555555555")
        );
    }

    #[test]
    fn ready_without_a_link_or_a_second_link_is_a_protocol_violation() {
        let (mut state, generation) = started();
        assert_eq!(state.on_line(at(1), generation, READY), LineOutcome::ProtocolViolation);
        assert_eq!(state.snapshot().failure_code, Some("protocol_failed"));
        assert!(state.open_target().is_none());

        let (mut state, generation) = started();
        state.on_line(at(1), generation, LINK);
        assert_eq!(state.on_line(at(2), generation, LINK), LineOutcome::ProtocolViolation);

        let (mut state, generation) = started();
        assert_eq!(
            state.on_line(at(1), generation, r#"{"type":"log","code":"made_up"}"#),
            LineOutcome::ProtocolViolation
        );
    }

    #[test]
    fn link_is_not_offered_before_ready() {
        let (mut state, generation) = started();
        state.on_line(at(1), generation, LINK);
        assert!(state.open_target().is_none());
        assert!(state.snapshot().web_ui_url.is_some());
    }

    #[test]
    fn a_retry_never_overlaps_a_process_that_may_still_be_alive() {
        let (mut state, generation) = started();
        assert!(state.begin_start().is_none(), "starting server must not be restarted");

        state.on_line(at(1), generation, r#"{"type":"failed","code":"READER_DATABASE_FAILED"}"#);
        assert_eq!(state.phase(), Phase::Failed);
        assert!(!state.snapshot().can_retry, "process may still be exiting");
        assert!(state.begin_start().is_none());

        assert_eq!(state.on_terminated(2, generation, true), Termination::Ignored);
        assert!(state.snapshot().can_retry);
        let second = state.begin_start().expect("retry after the process ended");
        assert_eq!(second, generation + 1);
        assert_eq!(state.phase(), Phase::Starting);
        assert!(state.snapshot().failure_code.is_none());
        assert!(state.begin_start().is_none(), "second retry while the new run is alive");
    }

    #[test]
    fn an_upgrade_is_offered_only_after_the_server_asked_for_it_and_ended() {
        let (mut state, generation) = started();
        assert!(state.begin_upgrade().is_none(), "nothing to upgrade while starting");
        state.on_line(at(1), generation, r#"{"type":"log","code":"reader_upgraded"}"#);
        assert_eq!(state.phase(), Phase::Starting);

        state.on_line(at(2),
            generation,
            r#"{"type":"failed","code":"READER_DATABASE_UPGRADE_REQUIRED"}"#,
        );
        assert_eq!(state.snapshot().failure_code, Some("READER_DATABASE_UPGRADE_REQUIRED"));
        assert!(!state.snapshot().can_upgrade, "process may still be exiting");
        assert!(state.begin_upgrade().is_none());

        state.on_terminated(3, generation, false);
        assert!(state.snapshot().can_upgrade);
        let upgrade = state.begin_upgrade().expect("upgrade after the process ended");
        assert_eq!(upgrade, generation + 1);
        assert!(!state.snapshot().can_upgrade);
        assert!(state.begin_upgrade().is_none(), "no second run while the upgrade runs");

        let (mut state, generation) = started();
        state.on_line(at(1), generation, r#"{"type":"failed","code":"READER_DATABASE_FAILED"}"#);
        state.on_terminated(2, generation, false);
        assert!(state.snapshot().can_retry);
        assert!(!state.snapshot().can_upgrade, "other failures are never upgraded");
        assert!(state.begin_upgrade().is_none());
    }

    #[test]
    fn the_upgrade_prompt_keeps_the_language_reported_before_the_failure() {
        let (mut state, generation) = started();
        assert_eq!(
            state.on_line(at(1), generation, r#"{"type":"preferences","uiLocale":"en","theme":"system"}"#),
            LineOutcome::Changed
        );
        state.on_line(at(2),
            generation,
            r#"{"type":"failed","code":"READER_DATABASE_UPGRADE_REQUIRED"}"#,
        );
        state.on_terminated(3, generation, false);
        let snapshot = state.snapshot();
        assert!(snapshot.can_upgrade);
        assert_eq!(snapshot.ui_locale, Some("en"));
        assert_eq!(snapshot.theme, Some("system"));

        state.begin_upgrade().expect("upgrade after the process ended");
        assert_eq!(state.snapshot().ui_locale, Some("en"), "a new run keeps the last language");
    }

    #[test]
    fn preferences_after_ready_are_a_protocol_violation() {
        let (mut state, generation) = running();
        assert_eq!(state.on_line(at(3), generation, PREFERENCES), LineOutcome::ProtocolViolation);
        assert_eq!(state.snapshot().failure_code, Some("protocol_failed"));
    }

    #[test]
    fn a_retry_ignores_the_old_runs_output_and_exit() {
        let (mut state, old) = started();
        state.on_line(at(1), old, r#"{"type":"failed","code":"SERVER_LISTEN_FAILED"}"#);
        state.on_terminated(2, old, true);
        let new = state.begin_start().unwrap();

        assert_eq!(state.on_line(at(3), old, LINK), LineOutcome::Unchanged);
        assert!(state.snapshot().web_ui_url.is_none());
        assert_eq!(state.on_terminated(4, old, true), Termination::Ignored);
        assert_eq!(state.phase(), Phase::Starting);

        state.on_line(at(5), new, LINK);
        state.on_line(at(6), new, READY);
        assert_eq!(state.phase(), Phase::Running);
    }

    #[test]
    fn an_unexpected_exit_fails_the_run_and_withdraws_the_link() {
        let (mut state, generation) = running();
        assert_eq!(state.on_terminated(9, generation, true), Termination::Failed);
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, Phase::Failed);
        assert_eq!(snapshot.failure_code, Some("server_exited"));
        assert!(snapshot.web_ui_url.is_none());
        assert!(state.open_target().is_none());
        assert!(snapshot.can_retry);
    }

    #[test]
    fn a_backend_failure_is_not_overwritten_by_the_exit_that_follows() {
        let (mut state, generation) = started();
        state.on_line(at(1), generation, r#"{"type":"failed","code":"PDFJS_ASSETS_FAILED"}"#);
        state.on_terminated(2, generation, true);
        assert_eq!(state.snapshot().failure_code, Some("PDFJS_ASSETS_FAILED"));
    }

    #[test]
    fn quitting_waits_for_the_server_and_then_exits() {
        let (mut state, generation) = running();
        assert_eq!(state.begin_stop(StopPurpose::Quit), StopPlan::SendShutdown { generation });
        assert_eq!(state.begin_stop(StopPurpose::Quit), StopPlan::AlreadyStopping);
        assert!(state.open_target().is_none(), "no browser link while stopping");

        // Late output from the stopping server is not acted on.
        assert_eq!(
            state.on_line(at(3), generation, r#"{"type":"log","code":"stopping"}"#),
            LineOutcome::Unchanged
        );
        assert_eq!(state.on_terminated(4, generation, true), Termination::Quit);
    }

    #[test]
    fn an_update_needs_the_stopped_acknowledgement_and_a_clean_exit() {
        let (mut state, generation) = running();
        assert_eq!(
            state.begin_stop(StopPurpose::Update),
            StopPlan::SendShutdown { generation }
        );
        assert_eq!(
            state.on_line(at(3), generation, r#"{"type":"stopped"}"#),
            LineOutcome::Changed
        );
        assert_eq!(
            state.on_terminated(4, generation, true),
            Termination::UpdateReady
        );

        let (mut state, generation) = running();
        state.begin_stop(StopPurpose::Update);
        assert_eq!(
            state.on_terminated(4, generation, true),
            Termination::UpdateAborted,
            "a missing stopped line must block the install"
        );
        assert_eq!(state.phase(), Phase::Failed);
        assert!(state.snapshot().can_retry);

        let (mut state, generation) = running();
        state.begin_stop(StopPurpose::Update);
        state.on_line(at(3), generation, r#"{"type":"stopped"}"#);
        assert_eq!(
            state.on_terminated(4, generation, false),
            Termination::UpdateAborted,
            "a killed or abnormal exit must block the install"
        );
    }

    #[test]
    fn a_quit_still_ends_without_the_stopped_acknowledgement() {
        let (mut state, generation) = running();
        state.begin_stop(StopPurpose::Quit);
        assert_eq!(state.on_terminated(3, generation, false), Termination::Quit);
    }

    #[test]
    fn quitting_without_a_server_exits_immediately() {
        let mut state = State::new("9.9.9", false, InstallMode::Download);
        assert_eq!(state.begin_stop(StopPurpose::Quit), StopPlan::ExitNow);

        let (mut state, generation) = started();
        state.on_terminated(1, generation, true);
        assert_eq!(state.begin_stop(StopPurpose::Quit), StopPlan::ExitNow);
    }

    #[test]
    fn overdue_checks_only_apply_to_the_run_they_were_armed_for() {
        let (mut state, generation) = started();
        assert_eq!(state.startup_check(at(1), generation + 1), WatchdogCheck::Settled);
        assert_eq!(state.startup_check(at(2), generation), WatchdogCheck::Overdue);
        assert_eq!(state.snapshot().failure_code, Some("startup_timeout"));
        assert_eq!(state.startup_check(at(3), generation), WatchdogCheck::Settled, "already failed");

        let (mut state, generation) = running();
        assert_eq!(state.startup_check(at(1), generation), WatchdogCheck::Settled, "ready in time");
        assert_eq!(state.shutdown_check(at(1), generation), WatchdogCheck::Settled, "not stopping");
        state.begin_stop(StopPurpose::Quit);
        assert_eq!(state.shutdown_check(at(2), generation + 1), WatchdogCheck::Settled);
        assert_eq!(state.shutdown_check(at(2), generation), WatchdogCheck::Overdue);
        assert_eq!(state.on_terminated(3, generation, true), Termination::Quit);
        assert_eq!(
            state.shutdown_check(at(4), generation),
            WatchdogCheck::Settled,
            "process already ended"
        );
    }

    #[test]
    fn an_approved_upgrade_has_no_deadline_until_the_database_opens() {
        let (mut state, generation) = started();
        state.on_line(at(1),
            generation,
            r#"{"type":"failed","code":"READER_DATABASE_UPGRADE_REQUIRED"}"#,
        );
        state.on_terminated(2, generation, false);
        let upgrade = state.begin_upgrade().expect("upgrade after the process ended");

        // Backing up and migrating a large library may take far longer than a normal start.
        assert_eq!(state.startup_check(at(45_000), upgrade), WatchdogCheck::Wait(STARTUP_TIMEOUT_MS));
        assert_eq!(state.startup_check(at(600_000), upgrade), WatchdogCheck::Wait(STARTUP_TIMEOUT_MS));
        assert_eq!(state.phase(), Phase::Starting);

        // Once the database is open, the rest of startup has the ordinary deadline.
        state.on_line(at(610_000), upgrade, r#"{"type":"log","code":"reader_upgraded"}"#);
        assert_eq!(state.startup_check(at(645_000), upgrade), WatchdogCheck::Wait(10_000));
        assert_eq!(state.startup_check(at(655_000), upgrade), WatchdogCheck::Overdue);
        assert_eq!(state.snapshot().failure_code, Some("startup_timeout"));

        // A database another run already upgraded opens without `reader_upgraded`.
        let (mut state, generation) = started();
        state.on_line(at(1),
            generation,
            r#"{"type":"failed","code":"READER_DATABASE_UPGRADE_REQUIRED"}"#,
        );
        state.on_terminated(2, generation, false);
        let upgrade = state.begin_upgrade().expect("upgrade after the process ended");
        state.on_line(at(3), upgrade, r#"{"type":"log","code":"reader_ready"}"#);
        assert_eq!(state.startup_check(at(45_000), upgrade), WatchdogCheck::Wait(3));

        // A normal retry keeps the plain deadline even after an upgrade run.
        state.on_line(at(4), upgrade, r#"{"type":"failed","code":"SERVER_LISTEN_FAILED"}"#);
        state.on_terminated(5, upgrade, false);
        let retry = state.begin_start().expect("retry after the process ended");
        assert_eq!(state.startup_check(at(45_000), retry), WatchdogCheck::Overdue);
    }

    #[test]
    fn deadlines_follow_the_monotonic_clock_not_the_wall_clock() {
        let (mut state, generation) = started();
        state.on_line(at(1), generation, r#"{"type":"failed","code":"READER_DATABASE_UPGRADE_REQUIRED"}"#);
        state.on_terminated(2, generation, false);
        let upgrade = state.begin_upgrade().expect("upgrade after the process ended");
        let opened = Moment {
            wall_ms: 1_000_000,
            monotonic_ms: 10_000,
        };
        state.on_line(opened, upgrade, r#"{"type":"log","code":"reader_upgraded"}"#);
        assert_eq!(state.snapshot().logs.last().unwrap().at, 1_000_000, "logs keep wall time");

        // The wall clock was set back; the deadline does not move.
        let later = Moment {
            wall_ms: 0,
            monotonic_ms: 40_000,
        };
        assert_eq!(state.startup_check(later, upgrade), WatchdogCheck::Wait(15_000));
        let overdue = Moment {
            wall_ms: 0,
            monotonic_ms: 55_000,
        };
        assert_eq!(state.startup_check(overdue, upgrade), WatchdogCheck::Overdue);
    }

    #[test]
    fn a_stop_during_an_approved_upgrade_waits_for_the_database() {
        let (mut state, generation) = started();
        state.on_line(at(1), generation, r#"{"type":"failed","code":"READER_DATABASE_UPGRADE_REQUIRED"}"#);
        state.on_terminated(2, generation, false);
        let upgrade = state.begin_upgrade().expect("upgrade after the process ended");
        assert_eq!(
            state.begin_stop(StopPurpose::Quit),
            StopPlan::SendShutdown { generation: upgrade }
        );

        // The server reads the shutdown request only after the upgrade; killing it would cut
        // the backup or the migration short.
        assert_eq!(state.shutdown_check(at(35_000), upgrade), WatchdogCheck::Wait(SHUTDOWN_TIMEOUT_MS));
        assert_eq!(state.shutdown_check(at(600_000), upgrade), WatchdogCheck::Wait(SHUTDOWN_TIMEOUT_MS));

        // Once the database is open, the ordinary deadline counts from there.
        assert_eq!(
            state.on_line(at(610_000), upgrade, r#"{"type":"log","code":"reader_upgraded"}"#),
            LineOutcome::Changed
        );
        assert_eq!(
            state.on_line(at(610_001), upgrade, r#"{"type":"log","code":"assets_ready"}"#),
            LineOutcome::Unchanged,
            "other output while stopping is still not acted on"
        );
        assert_eq!(state.shutdown_check(at(635_000), upgrade), WatchdogCheck::Wait(10_000));
        assert_eq!(state.shutdown_check(at(645_000), upgrade), WatchdogCheck::Overdue);
        assert_eq!(state.on_terminated(645_001, upgrade, false), Termination::Quit);
    }

    /// Stands in for the child handle, whose drop kills the process: counts how often it is released.
    struct Process(Rc<Cell<u32>>);

    impl Drop for Process {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }

    #[test]
    fn a_late_release_for_an_old_run_leaves_the_newer_process_alone() {
        let released = Rc::new(Cell::new(0));
        let (mut state, old) = started();
        let mut slot = Some((old, Process(released.clone())));

        // The old run's startup watchdog fires, but the process ends on its own before the kill.
        assert_eq!(state.startup_check(at(1), old), WatchdogCheck::Overdue);
        assert_eq!(state.on_terminated(2, old, true), Termination::Ignored);
        drop(take_run(&mut slot, old));
        assert_eq!(released.get(), 1);

        let new = state.begin_start().expect("the old process has ended");
        slot = Some((new, Process(released.clone())));

        // The old watchdog's kill finally runs.
        assert!(take_run(&mut slot, old).is_none());
        assert_eq!(released.get(), 1, "the new run's process must survive");
        assert!(matches!(slot, Some((owner, _)) if owner == new));

        drop(take_run(&mut slot, new));
        assert_eq!(released.get(), 2, "the owner releases it exactly once");
        assert!(take_run(&mut slot, new).is_none());
        assert_eq!(released.get(), 2);

        let mut empty: Option<(u64, Process)> = None;
        assert!(take_run(&mut empty, new).is_none());
    }

    #[test]
    fn spawn_failure_is_reported_and_can_be_retried() {
        let mut state = State::new("9.9.9", false, InstallMode::Download);
        state.begin_start().unwrap();
        state.spawn_failed(1, "sidecar_missing");
        let snapshot = state.snapshot();
        assert_eq!(snapshot.failure_code, Some("sidecar_missing"));
        assert!(snapshot.can_retry);
        assert!(state.begin_start().is_some());
    }

    #[test]
    fn the_activity_log_keeps_the_latest_entries_only() {
        let (mut state, _) = started();
        for at in 0..(LOG_LIMIT as u64 + 25) {
            state.note(at, Level::Info, "link_copied");
        }
        let logs = state.snapshot().logs;
        assert_eq!(logs.len(), LOG_LIMIT);
        assert_eq!(logs.first().unwrap().at, 25);
        assert_eq!(logs.last().unwrap().at, LOG_LIMIT as u64 + 24);
    }

    #[test]
    fn every_change_advances_the_revision() {
        let (mut state, generation) = started();
        let mut seen = state.snapshot().revision;
        for line in [LINK, r#"{"type":"log","code":"assets_ready"}"#, READY] {
            state.on_line(at(1), generation, line);
            let now = state.snapshot().revision;
            assert!(now > seen, "{line}");
            seen = now;
        }
    }

    fn enabled_state(mode: InstallMode) -> State {
        let mut state = State::new("9.9.9", true, mode);
        assert!(state.initialize_updates());
        state
    }

    /// The adapter's install admission order: early eligibility, then resource admission.
    fn admit_install(state: &mut State, pending: Option<&str>) -> bool {
        state.can_install_update() && state.begin_update_install(pending)
    }

    fn running_with_updates(mode: InstallMode) -> (State, u64) {
        let mut state = enabled_state(mode);
        let generation = state.begin_start().expect("first start is allowed");
        assert_eq!(state.on_line(at(1), generation, LINK), LineOutcome::Changed);
        assert_eq!(state.on_line(at(2), generation, READY), LineOutcome::Changed);
        (state, generation)
    }

    #[test]
    fn disabled_updates_never_admit_work() {
        let mut state = State::new("9.9.9", false, InstallMode::InApp);
        assert!(!state.initialize_updates());
        let snapshot = state.snapshot().update;
        assert_eq!(snapshot.phase, UpdatePhase::Disabled);
        assert!(snapshot.version.is_none());
        assert_eq!(snapshot.install_mode, InstallMode::InApp);

        assert!(!state.begin_update_check(false));
        assert!(!state.begin_update_download(Some("2.0.0"), false));
        assert!(!admit_install(&mut state, Some("2.0.0")));
        assert_eq!(state.snapshot().update.phase, UpdatePhase::Disabled);
    }

    #[test]
    fn enabled_updates_start_idle_with_the_running_version() {
        let state = enabled_state(InstallMode::Download);
        let snapshot = state.snapshot().update;
        assert_eq!(snapshot.phase, UpdatePhase::Idle);
        assert_eq!(snapshot.version.as_deref(), Some("9.9.9"));
        assert_eq!(snapshot.install_mode, InstallMode::Download);
    }

    #[test]
    fn a_check_offers_an_update_and_a_failed_check_keeps_the_offer() {
        let mut state = enabled_state(InstallMode::InApp);
        assert!(state.begin_update_check(false));
        assert_eq!(state.snapshot().update.phase, UpdatePhase::Checking);

        assert_eq!(
            state.finish_update_check(Ok(Some("2.0.0".into()))),
            CheckResourcePlan::StoreAvailable
        );
        let snapshot = state.snapshot().update;
        assert_eq!(snapshot.phase, UpdatePhase::Available);
        assert_eq!(snapshot.version.as_deref(), Some("2.0.0"));

        assert!(
            state.begin_update_check(false),
            "an offered update does not block another check"
        );
        assert_eq!(
            state.finish_update_check(Err(())),
            CheckResourcePlan::KeepAvailable
        );
        let snapshot = state.snapshot().update;
        assert_eq!(snapshot.phase, UpdatePhase::Failed);
        assert_eq!(snapshot.version.as_deref(), Some("9.9.9"));
        assert_eq!(snapshot.error_code, Some(UpdateError::CheckFailed));

        assert!(state.begin_update_check(false));
        assert_eq!(state.finish_update_check(Ok(None)), CheckResourcePlan::ClearAvailable);
        let snapshot = state.snapshot().update;
        assert_eq!(snapshot.phase, UpdatePhase::Current);
        assert_eq!(snapshot.version.as_deref(), Some("9.9.9"));
        assert!(snapshot.error_code.is_none());
    }

    #[test]
    fn a_check_that_finishes_while_stopping_changes_nothing() {
        let (mut state, generation) = running_with_updates(InstallMode::InApp);
        assert!(state.begin_update_check(false));
        state.begin_stop(StopPurpose::Quit);
        let revision = state.snapshot().revision;
        assert_eq!(
            state.finish_update_check(Ok(Some("2.0.0".into()))),
            CheckResourcePlan::ClearAvailable
        );
        assert_eq!(state.snapshot().revision, revision);
        assert!(state.begin_update_check(false), "checking was released");
        assert_eq!(state.snapshot().update.phase, UpdatePhase::Checking);
        assert_eq!(state.on_terminated(3, generation, true), Termination::Quit);
    }

    #[test]
    fn a_download_may_start_during_a_check_and_pending_blocks_a_second() {
        for result in [Ok(Some("3.0.0".into())), Ok(None), Err(())] {
            let mut state = enabled_state(InstallMode::InApp);
            assert!(state.begin_update_check(false));
            assert!(state.begin_update_download(Some("2.0.0"), false));
            assert_eq!(state.snapshot().update.phase, UpdatePhase::Downloading);
            assert_eq!(
                state.finish_update_download("2.0.0".into(), true),
                DownloadResourcePlan::StorePending
            );
            let snapshot = state.snapshot().update;
            assert_eq!(snapshot.phase, UpdatePhase::Ready);
            assert_eq!(snapshot.version.as_deref(), Some("2.0.0"));

            assert!(!state.begin_update_check(true));
            assert!(!state.begin_update_download(Some("2.0.0"), true));
            assert!(!state.begin_update_install(None));

            // The check completes after the download: the newer download owns the panel state.
            assert_eq!(
                state.finish_update_check(result),
                CheckResourcePlan::KeepAvailable
            );
            let snapshot = state.snapshot().update;
            assert_eq!(snapshot.phase, UpdatePhase::Ready);
            assert_eq!(snapshot.version.as_deref(), Some("2.0.0"));
            assert!(snapshot.error_code.is_none());
            assert!(admit_install(&mut state, Some("2.0.0")));
        }
    }

    #[test]
    fn late_checks_preserve_newer_download_and_install_state() {
        for result in [Ok(Some("3.0.0".into())), Ok(None), Err(())] {
            let mut downloading = enabled_state(InstallMode::InApp);
            assert!(downloading.begin_update_check(false));
            assert!(downloading.begin_update_download(Some("2.0.0"), false));
            let before = downloading.snapshot();
            assert_eq!(
                downloading.finish_update_check(result.clone()),
                CheckResourcePlan::KeepAvailable
            );
            let after = downloading.snapshot();
            assert_eq!(after.update.phase, before.update.phase);
            assert_eq!(after.update.version, before.update.version);
            assert_eq!(after.update.error_code, before.update.error_code);
            assert_eq!(after.revision, before.revision);
            assert_eq!(
                downloading.finish_update_download("2.0.0".into(), true),
                DownloadResourcePlan::StorePending
            );
            let snapshot = downloading.snapshot().update;
            assert_eq!(snapshot.phase, UpdatePhase::Ready);
            assert_eq!(snapshot.version.as_deref(), Some("2.0.0"));

            let mut failed = enabled_state(InstallMode::InApp);
            assert!(failed.begin_update_check(false));
            assert!(failed.begin_update_download(Some("2.0.0"), false));
            assert_eq!(
                failed.finish_update_download("2.0.0".into(), false),
                DownloadResourcePlan::KeepAvailable
            );
            let before = failed.snapshot();
            assert_eq!(
                failed.finish_update_check(result.clone()),
                CheckResourcePlan::KeepAvailable
            );
            let after = failed.snapshot();
            assert_eq!(after.update.phase, before.update.phase);
            assert_eq!(after.update.version, before.update.version);
            assert_eq!(after.update.error_code, before.update.error_code);
            assert_eq!(after.revision, before.revision);
            assert!(failed.begin_update_check(false), "the check gate was released");

            let mut installing = enabled_state(InstallMode::InApp);
            assert!(installing.begin_update_check(false));
            assert!(installing.begin_update_download(Some("2.0.0"), false));
            assert_eq!(
                installing.finish_update_download("2.0.0".into(), true),
                DownloadResourcePlan::StorePending
            );
            assert!(installing.begin_update_install(Some("2.0.0")));
            let before = installing.snapshot();
            assert_eq!(
                installing.finish_update_check(result),
                CheckResourcePlan::KeepAvailable
            );
            let after = installing.snapshot();
            assert_eq!(after.update.phase, before.update.phase);
            assert_eq!(after.update.version, before.update.version);
            assert_eq!(after.update.error_code, before.update.error_code);
            assert_eq!(after.revision, before.revision);
            assert!(!installing.begin_update_install(Some("2.0.0")));
        }
    }

    #[test]
    fn a_failed_or_stopped_download_keeps_the_offered_update() {
        let mut state = enabled_state(InstallMode::InApp);
        assert!(state.begin_update_download(Some("2.0.0"), false));
        assert_eq!(
            state.finish_update_download("2.0.0".into(), false),
            DownloadResourcePlan::KeepAvailable
        );
        let snapshot = state.snapshot().update;
        assert_eq!(snapshot.phase, UpdatePhase::Failed);
        assert_eq!(snapshot.error_code, Some(UpdateError::DownloadFailed));
        assert_eq!(snapshot.version.as_deref(), Some("2.0.0"));

        let mut state = enabled_state(InstallMode::InApp);
        assert!(!state.begin_update_download(None, false));
        assert!(state.begin_update_download(Some("2.0.0"), false));
        let revision = state.snapshot().revision;
        state.begin_stop(StopPurpose::Quit);
        assert_eq!(
            state.finish_update_download("2.0.0".into(), true),
            DownloadResourcePlan::KeepAvailable
        );
        let snapshot = state.snapshot().update;
        assert_eq!(snapshot.phase, UpdatePhase::Downloading);
        assert_eq!(state.snapshot().revision, revision + 1);
    }

    #[test]
    fn install_admission_publishes_before_the_update_stop() {
        let (mut state, generation) = running_with_updates(InstallMode::InApp);
        assert!(state.can_install_update());
        assert!(!state.begin_update_install(None));

        assert!(state.begin_update_install(Some("2.0.0")));
        let snapshot = state.snapshot().update;
        assert_eq!(snapshot.phase, UpdatePhase::Installing);
        assert_eq!(snapshot.version.as_deref(), Some("2.0.0"));
        assert!(!state.begin_update_install(Some("2.0.0")));

        assert_eq!(
            state.begin_stop(StopPurpose::Update),
            StopPlan::SendShutdown { generation }
        );
        state.on_line(at(3), generation, r#"{"type":"stopped"}"#);
        assert_eq!(state.on_terminated(4, generation, true), Termination::UpdateReady);
    }

    #[test]
    fn only_an_in_app_build_may_install_and_not_while_stopping() {
        let mut download = enabled_state(InstallMode::Download);
        assert!(!admit_install(&mut download, Some("2.0.0")));

        let (mut state, _) = running_with_updates(InstallMode::InApp);
        state.begin_stop(StopPurpose::Quit);
        assert!(!admit_install(&mut state, Some("2.0.0")));
    }

    #[test]
    fn an_install_admitted_during_a_quit_keeps_the_existing_interleaving() {
        let (mut state, _) = running_with_updates(InstallMode::InApp);
        assert!(state.can_install_update());
        state.begin_stop(StopPurpose::Quit);
        // The early check already passed; admission does not recheck the phase.
        assert!(state.begin_update_install(Some("2.0.0")));
        assert_eq!(state.snapshot().update.phase, UpdatePhase::Installing);
        assert_eq!(
            state.begin_stop(StopPurpose::Update),
            StopPlan::AlreadyStopping
        );
    }

    #[test]
    fn the_first_stop_purpose_wins_between_quit_and_install() {
        let (mut state, _) = running_with_updates(InstallMode::InApp);
        state.begin_stop(StopPurpose::Quit);
        assert_eq!(
            state.begin_stop(StopPurpose::Update),
            StopPlan::AlreadyStopping
        );

        let (mut state, generation) = running_with_updates(InstallMode::InApp);
        state.begin_stop(StopPurpose::Update);
        assert_eq!(
            state.begin_stop(StopPurpose::Quit),
            StopPlan::AlreadyStopping
        );
        state.on_line(at(3), generation, r#"{"type":"stopped"}"#);
        assert_eq!(state.on_terminated(4, generation, true), Termination::UpdateReady);
    }

    #[test]
    fn install_and_shutdown_failures_publish_distinct_errors() {
        let mut state = enabled_state(InstallMode::InApp);
        assert!(state.begin_update_install(Some("2.0.0")));
        state.show_update_installing(Some("2.0.0".into()));
        state.finish_update_install(Some("2.0.0".into()));
        let snapshot = state.snapshot().update;
        assert_eq!(snapshot.phase, UpdatePhase::Failed);
        assert_eq!(snapshot.error_code, Some(UpdateError::InstallFailed));
        assert_eq!(snapshot.version.as_deref(), Some("2.0.0"));

        assert!(state.begin_update_install(Some("2.0.0")));
        state.update_shutdown_failed(Some("2.0.0".into()));
        let snapshot = state.snapshot().update;
        assert_eq!(snapshot.phase, UpdatePhase::Failed);
        assert_eq!(snapshot.error_code, Some(UpdateError::ShutdownFailed));
        assert_eq!(snapshot.version.as_deref(), Some("2.0.0"));
    }

    #[test]
    fn an_install_failure_restores_a_stopping_launcher_to_a_retryable_failure() {
        let (mut state, generation) = running_with_updates(InstallMode::InApp);
        assert!(state.begin_update_install(Some("2.0.0")));
        state.begin_stop(StopPurpose::Update);
        state.on_line(at(3), generation, r#"{"type":"stopped"}"#);
        assert_eq!(state.on_terminated(4, generation, true), Termination::UpdateReady);

        state.set_exit_allowed(true);
        assert!(state.can_exit());
        state.set_exit_allowed(false);
        state.finish_update_install(Some("2.0.0".into()));
        state.update_install_failed();
        let snapshot = state.snapshot();
        assert_eq!(snapshot.phase, Phase::Failed);
        assert!(snapshot.can_retry, "the sidecar has already exited");
        assert!(!state.can_exit());
        assert_eq!(snapshot.update.error_code, Some(UpdateError::InstallFailed));
    }

    #[test]
    fn exit_is_permitted_only_when_the_lifecycle_says_so() {
        let mut state = enabled_state(InstallMode::InApp);
        assert!(!state.can_exit());
        state.set_exit_allowed(true);
        assert!(state.can_exit());
        state.set_exit_allowed(false);
        assert!(!state.can_exit());

        let wire = serde_json::to_string(&state.snapshot()).unwrap();
        assert!(!wire.contains("exitAllowed"));
        assert!(!wire.contains("canExit"));
    }

    #[test]
    fn download_mode_opens_the_pending_release_before_the_offered_one() {
        let state = enabled_state(InstallMode::Download);
        assert_eq!(
            state.update_download_version(Some("1.9.0"), Some("2.0.0")),
            Some("1.9.0")
        );
        assert_eq!(
            state.update_download_version(None, Some("2.0.0")),
            Some("2.0.0")
        );
        assert_eq!(state.update_download_version(None, None), None);

        let in_app = enabled_state(InstallMode::InApp);
        assert_eq!(in_app.update_download_version(Some("1.9.0"), None), None);
    }

    #[test]
    fn crate_version_matches_the_package_version() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../package.json");
        let package: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(manifest).unwrap()).unwrap();
        assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));
    }
}
