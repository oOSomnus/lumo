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
pub const SHUTDOWN_TIMEOUT_SECS: u64 = 35;
pub const SHUTDOWN_COMMAND: &[u8] = b"{\"type\":\"shutdown\"}\n";

const ACCESS_LINE_PREFIX: &str = "Open in your browser: ";

const SERVER_LOG_CODES: &[&str] = &[
    "starting",
    "reader_ready",
    "assets_ready",
    "credentials_ready",
    "stopping",
];
const SERVER_FAILURE_CODES: &[&str] = &[
    "DATA_DIRECTORY_INVALID",
    "READER_DATABASE_FAILED",
    "PDFJS_ASSETS_FAILED",
    "TYPST_ASSETS_FAILED",
    "CREDENTIALS_DATABASE_FAILED",
    "SERVER_LISTEN_FAILED",
    "CONTROL_PROTOCOL_INVALID",
];
const UI_LOCALES: &[&str] = &["en", "zh-CN"];

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
    Ready {
        data_directory: String,
        ui_locale: &'static str,
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
    Ready {
        #[serde(rename = "dataDirectory")]
        data_directory: String,
        #[serde(rename = "uiLocale")]
        ui_locale: String,
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
        WireEvent::Ready {
            data_directory,
            ui_locale,
        } => known(UI_LOCALES, &ui_locale)
            .filter(|_| !data_directory.is_empty())
            .map(|ui_locale| Event::Ready {
                data_directory,
                ui_locale,
            }),
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
    pub failure_code: Option<&'static str>,
    pub can_retry: bool,
    pub logs: Vec<LogEntry>,
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
}

#[derive(Debug, PartialEq, Eq)]
pub enum StopPlan {
    AlreadyStopping,
    /// No server process to wait for.
    ExitNow,
    /// Send the shutdown command and watch for this process to end in time.
    SendShutdown { generation: u64 },
}

pub struct State {
    version: &'static str,
    revision: u64,
    generation: u64,
    phase: Phase,
    process_alive: bool,
    link: Option<AccessLink>,
    data_directory: Option<String>,
    ui_locale: Option<&'static str>,
    failure_code: Option<&'static str>,
    logs: VecDeque<LogEntry>,
}

impl State {
    pub fn new(version: &'static str) -> Self {
        Self {
            version,
            revision: 0,
            generation: 0,
            phase: Phase::Starting,
            process_alive: false,
            link: None,
            data_directory: None,
            ui_locale: None,
            failure_code: None,
            logs: VecDeque::new(),
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            revision: self.revision,
            version: self.version,
            phase: self.phase,
            web_ui_url: self.link.as_ref().map(|link| link.base.clone()),
            data_directory: self.data_directory.clone(),
            ui_locale: self.ui_locale,
            failure_code: self.failure_code,
            can_retry: self.can_retry(),
            logs: self.logs.iter().cloned().collect(),
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    fn can_retry(&self) -> bool {
        self.phase == Phase::Failed && !self.process_alive
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
        self.revision += 1;
        Some(self.generation)
    }

    /// The process could not be spawned at all.
    pub fn spawn_failed(&mut self, at: u64, code: &'static str) {
        self.process_alive = false;
        self.fail(at, code);
    }

    pub fn on_line(&mut self, at: u64, generation: u64, line: &str) -> LineOutcome {
        if generation != self.generation || !self.process_alive {
            return LineOutcome::Unchanged;
        }
        let parsed = parse_line(line);
        match (self.phase, parsed) {
            (_, Parsed::Ignored) => LineOutcome::Unchanged,
            // Output after failing or while quitting is not acted on.
            (Phase::Failed, _) => LineOutcome::Unchanged,
            (Phase::Stopping, _) => LineOutcome::Unchanged,
            (_, Parsed::Invalid) => self.violation(at),
            (Phase::Starting, Parsed::Access(link)) if self.link.is_none() => {
                self.link = Some(link);
                self.revision += 1;
                LineOutcome::Changed
            }
            (_, Parsed::Access(_)) => self.violation(at),
            (_, Parsed::Event(Event::Log(code))) => {
                self.push(at, Level::Info, code);
                LineOutcome::Changed
            }
            (Phase::Starting, Parsed::Event(Event::Ready { data_directory, ui_locale }))
                if self.link.is_some() =>
            {
                self.phase = Phase::Running;
                self.data_directory = Some(data_directory);
                self.ui_locale = Some(ui_locale);
                self.push(at, Level::Info, "ready");
                LineOutcome::Changed
            }
            (_, Parsed::Event(Event::Ready { .. })) => self.violation(at),
            (_, Parsed::Event(Event::Failed(code))) => {
                self.fail(at, code);
                LineOutcome::Changed
            }
            (_, Parsed::Event(Event::Stopped)) => LineOutcome::Unchanged,
        }
    }

    fn violation(&mut self, at: u64) -> LineOutcome {
        self.fail(at, "protocol_failed");
        LineOutcome::ProtocolViolation
    }

    pub fn on_terminated(&mut self, at: u64, generation: u64) -> Termination {
        if generation != self.generation || !self.process_alive {
            return Termination::Ignored;
        }
        self.process_alive = false;
        match self.phase {
            Phase::Stopping => {
                self.revision += 1;
                Termination::Quit
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
    pub fn startup_overdue(&mut self, at: u64, generation: u64) -> bool {
        let overdue = generation == self.generation
            && self.process_alive
            && self.phase == Phase::Starting;
        if overdue {
            self.fail(at, "startup_timeout");
        }
        overdue
    }

    pub fn begin_stop(&mut self) -> StopPlan {
        if self.phase == Phase::Stopping {
            return StopPlan::AlreadyStopping;
        }
        self.phase = Phase::Stopping;
        self.link = None;
        self.revision += 1;
        if self.process_alive {
            StopPlan::SendShutdown {
                generation: self.generation,
            }
        } else {
            StopPlan::ExitNow
        }
    }

    /// True when the server ignored the shutdown request for too long and must be killed.
    pub fn shutdown_overdue(&mut self, at: u64, generation: u64) -> bool {
        let overdue = generation == self.generation
            && self.process_alive
            && self.phase == Phase::Stopping;
        if overdue {
            self.push(at, Level::Warn, "shutdown_timeout");
        }
        overdue
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
    const READY: &str = r#"{"type":"ready","dataDirectory":"/data/lumo","uiLocale":"zh-CN"}"#;

    fn started() -> (State, u64) {
        let mut state = State::new("9.9.9");
        let generation = state.begin_start().expect("first start is allowed");
        (state, generation)
    }

    fn running() -> (State, u64) {
        let (mut state, generation) = started();
        assert_eq!(state.on_line(1, generation, LINK), LineOutcome::Changed);
        assert_eq!(state.on_line(2, generation, READY), LineOutcome::Changed);
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
                ui_locale: "zh-CN"
            })
        );
        for bad in [
            r#"{"type":"log","code":"made_up"}"#,
            r#"{"type":"failed","code":"made_up"}"#,
            r#"{"type":"log","code":"starting","extra":1}"#,
            r#"{"type":"ready","dataDirectory":"","uiLocale":"en"}"#,
            r#"{"type":"ready","dataDirectory":"/d","uiLocale":"fr"}"#,
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
        assert_eq!(state.on_line(1, generation, READY), LineOutcome::ProtocolViolation);
        assert_eq!(state.snapshot().failure_code, Some("protocol_failed"));
        assert!(state.open_target().is_none());

        let (mut state, generation) = started();
        state.on_line(1, generation, LINK);
        assert_eq!(state.on_line(2, generation, LINK), LineOutcome::ProtocolViolation);

        let (mut state, generation) = started();
        assert_eq!(
            state.on_line(1, generation, r#"{"type":"log","code":"made_up"}"#),
            LineOutcome::ProtocolViolation
        );
    }

    #[test]
    fn link_is_not_offered_before_ready() {
        let (mut state, generation) = started();
        state.on_line(1, generation, LINK);
        assert!(state.open_target().is_none());
        assert!(state.snapshot().web_ui_url.is_some());
    }

    #[test]
    fn a_retry_never_overlaps_a_process_that_may_still_be_alive() {
        let (mut state, generation) = started();
        assert!(state.begin_start().is_none(), "starting server must not be restarted");

        state.on_line(1, generation, r#"{"type":"failed","code":"READER_DATABASE_FAILED"}"#);
        assert_eq!(state.phase(), Phase::Failed);
        assert!(!state.snapshot().can_retry, "process may still be exiting");
        assert!(state.begin_start().is_none());

        assert_eq!(state.on_terminated(2, generation), Termination::Ignored);
        assert!(state.snapshot().can_retry);
        let second = state.begin_start().expect("retry after the process ended");
        assert_eq!(second, generation + 1);
        assert_eq!(state.phase(), Phase::Starting);
        assert!(state.snapshot().failure_code.is_none());
        assert!(state.begin_start().is_none(), "second retry while the new run is alive");
    }

    #[test]
    fn a_retry_ignores_the_old_runs_output_and_exit() {
        let (mut state, old) = started();
        state.on_line(1, old, r#"{"type":"failed","code":"SERVER_LISTEN_FAILED"}"#);
        state.on_terminated(2, old);
        let new = state.begin_start().unwrap();

        assert_eq!(state.on_line(3, old, LINK), LineOutcome::Unchanged);
        assert!(state.snapshot().web_ui_url.is_none());
        assert_eq!(state.on_terminated(4, old), Termination::Ignored);
        assert_eq!(state.phase(), Phase::Starting);

        state.on_line(5, new, LINK);
        state.on_line(6, new, READY);
        assert_eq!(state.phase(), Phase::Running);
    }

    #[test]
    fn an_unexpected_exit_fails_the_run_and_withdraws_the_link() {
        let (mut state, generation) = running();
        assert_eq!(state.on_terminated(9, generation), Termination::Failed);
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
        state.on_line(1, generation, r#"{"type":"failed","code":"PDFJS_ASSETS_FAILED"}"#);
        state.on_terminated(2, generation);
        assert_eq!(state.snapshot().failure_code, Some("PDFJS_ASSETS_FAILED"));
    }

    #[test]
    fn quitting_waits_for_the_server_and_then_exits() {
        let (mut state, generation) = running();
        assert_eq!(state.begin_stop(), StopPlan::SendShutdown { generation });
        assert_eq!(state.begin_stop(), StopPlan::AlreadyStopping);
        assert!(state.open_target().is_none(), "no browser link while stopping");

        // Late output from the stopping server is not acted on.
        assert_eq!(
            state.on_line(3, generation, r#"{"type":"log","code":"stopping"}"#),
            LineOutcome::Unchanged
        );
        assert_eq!(state.on_terminated(4, generation), Termination::Quit);
    }

    #[test]
    fn quitting_without_a_server_exits_immediately() {
        let mut state = State::new("9.9.9");
        assert_eq!(state.begin_stop(), StopPlan::ExitNow);

        let (mut state, generation) = started();
        state.on_terminated(1, generation);
        assert_eq!(state.begin_stop(), StopPlan::ExitNow);
    }

    #[test]
    fn overdue_checks_only_apply_to_the_run_they_were_armed_for() {
        let (mut state, generation) = started();
        assert!(!state.startup_overdue(1, generation + 1));
        assert!(state.startup_overdue(2, generation));
        assert_eq!(state.snapshot().failure_code, Some("startup_timeout"));
        assert!(!state.startup_overdue(3, generation), "already failed");

        let (mut state, generation) = running();
        assert!(!state.startup_overdue(1, generation), "ready in time");
        assert!(!state.shutdown_overdue(1, generation), "not stopping");
        state.begin_stop();
        assert!(state.shutdown_overdue(2, generation));
        assert_eq!(state.on_terminated(3, generation), Termination::Quit);
        assert!(!state.shutdown_overdue(4, generation), "process already ended");
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
        assert!(state.startup_overdue(1, old));
        assert_eq!(state.on_terminated(2, old), Termination::Ignored);
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
        let mut state = State::new("9.9.9");
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
            state.on_line(1, generation, line);
            let now = state.snapshot().revision;
            assert!(now > seen, "{line}");
            seen = now;
        }
    }

    #[test]
    fn crate_version_matches_the_package_version() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../package.json");
        let package: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(manifest).unwrap()).unwrap();
        assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));
    }
}
