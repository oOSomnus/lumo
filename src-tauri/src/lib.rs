//! Lumo desktop launcher: owns one `lumo-server --desktop` child, shows its state, and hands
//! the browser the access link. The reader itself stays in the system browser.

mod launcher;
mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, RunEvent, State as TauriState, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use launcher::{
    take_run, Level, LineOutcome, Phase, Snapshot, State, StopPlan, StopPurpose, Termination,
    SHUTDOWN_COMMAND, SHUTDOWN_TIMEOUT_SECS, STARTUP_TIMEOUT_SECS,
};
use updater::LauncherUpdateState;

const STATE_EVENT: &str = "launcher-state";
const QUIT_EVENT: &str = "quit-requested";

struct Shared {
    state: Mutex<State>,
    /// The running server with the generation that spawned it; see [`take_run`].
    child: Mutex<Option<(u64, CommandChild)>>,
    quitting: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Mutates the launcher state and publishes the new snapshot to the panel.
fn update<T>(app: &AppHandle, change: impl FnOnce(&mut State) -> T) -> T {
    let shared = app.state::<Shared>();
    let (result, snapshot) = {
        let mut state = lock(&shared.state);
        let result = change(&mut state);
        (result, state.snapshot())
    };
    let _ = app.emit(STATE_EVENT, snapshot);
    result
}

pub(crate) fn set_update_state(app: &AppHandle, next: LauncherUpdateState) {
    update(app, |state| state.set_update(next));
}

pub(crate) fn launcher_phase(app: &AppHandle) -> Phase {
    lock(&app.state::<Shared>().state).phase()
}

pub(crate) fn set_quitting(app: &AppHandle, value: bool) {
    app.state::<Shared>().quitting.store(value, Ordering::SeqCst);
}

pub(crate) fn update_install_failed(app: &AppHandle) {
    update(app, |state| state.update_install_failed());
}

fn kill_child(app: &AppHandle, generation: u64) {
    let child = take_run(&mut lock(&app.state::<Shared>().child), generation);
    if let Some(child) = child {
        // `kill` waits for the process to be gone.
        tauri::async_runtime::spawn_blocking(move || {
            let _ = child.kill();
        });
    }
}

fn finish_exit(app: &AppHandle) {
    app.state::<Shared>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn handle_terminated(app: &AppHandle, generation: u64, success: bool) {
    // Dropping the handle also clears anything left in the server's process group.
    drop(take_run(&mut lock(&app.state::<Shared>().child), generation));
    match update(app, |state| {
        state.on_terminated(now_ms(), generation, success)
    }) {
        Termination::Quit => finish_exit(app),
        Termination::UpdateReady => updater::install_pending(app),
        Termination::UpdateAborted => updater::shutdown_failed(app),
        Termination::Ignored | Termination::Failed => {}
    }
}

fn handle_stdout(app: &AppHandle, generation: u64, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    if update(app, |state| state.on_line(now_ms(), generation, &line)) == LineOutcome::ProtocolViolation
    {
        kill_child(app, generation);
    }
}

fn start_server(app: &AppHandle) {
    let Some(generation) = update(app, |state| state.begin_start()) else {
        return;
    };

    let spawned = app.shell().sidecar("lumo-server").and_then(|command| {
        command
            .args(["--desktop"])
            .set_process_group(true)
            .kill_on_drop(true)
            .spawn()
    });
    let (mut events, child) = match spawned {
        Ok(spawned) => spawned,
        Err(_) => {
            update(app, |state| state.spawn_failed(now_ms(), "sidecar_missing"));
            return;
        }
    };
    *lock(&app.state::<Shared>().child) = Some((generation, child));

    let reader = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut success = false;
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => handle_stdout(&reader, generation, &bytes),
                CommandEvent::Terminated(payload) => {
                    success = payload.code == Some(0);
                    break;
                }
                // Server stderr is drained so the pipe never blocks, and never shown.
                _ => {}
            }
        }
        handle_terminated(&reader, generation, success);
    });

    let watchdog = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(STARTUP_TIMEOUT_SECS)).await;
        if update(&watchdog, |state| state.startup_overdue(now_ms(), generation)) {
            kill_child(&watchdog, generation);
        }
    });
}

pub(crate) fn request_stop(app: &AppHandle, purpose: StopPurpose) {
    match update(app, |state| state.begin_stop(purpose)) {
        StopPlan::AlreadyStopping => {}
        StopPlan::ExitNow => {
            if purpose == StopPurpose::Update {
                updater::install_pending(app);
            } else {
                finish_exit(app);
            }
        }
        StopPlan::SendShutdown { generation } => {
            let asked = lock(&app.state::<Shared>().child)
                .as_mut()
                .is_some_and(|(owner, child)| {
                    *owner == generation && child.write(SHUTDOWN_COMMAND).is_ok()
                });
            if !asked {
                // Without stdin there is no polite way to stop it.
                kill_child(app, generation);
            }
            let watchdog = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(SHUTDOWN_TIMEOUT_SECS)).await;
                if update(&watchdog, |state| state.shutdown_overdue(now_ms(), generation)) {
                    kill_child(&watchdog, generation);
                }
            });
        }
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Window close, menu Quit and the panel's own button share this path. While the server is
/// running the panel asks first, because the browser may hold unsaved work.
fn handle_quit_request(app: &AppHandle) {
    let running = lock(&app.state::<Shared>().state).phase() == Phase::Running;
    if running {
        focus_main(app);
        let _ = app.emit(QUIT_EVENT, ());
    } else {
        request_stop(app, StopPurpose::Quit);
    }
}

#[tauri::command]
fn get_snapshot(shared: TauriState<'_, Shared>) -> Snapshot {
    lock(&shared.state).snapshot()
}

#[tauri::command]
fn open_webui(app: AppHandle) {
    let Some(target) = lock(&app.state::<Shared>().state)
        .open_target()
        .map(str::to_owned)
    else {
        return;
    };
    let opened = app.opener().open_url(target, None::<&str>).is_ok();
    update(&app, |state| {
        if opened {
            state.note(now_ms(), Level::Info, "browser_opened");
        } else {
            state.note(now_ms(), Level::Error, "browser_open_failed");
        }
    });
}

#[tauri::command]
fn copy_webui_url(app: AppHandle) {
    let Some(target) = lock(&app.state::<Shared>().state)
        .open_target()
        .map(str::to_owned)
    else {
        return;
    };
    let copied = app.clipboard().write_text(target).is_ok();
    update(&app, |state| {
        if copied {
            state.note(now_ms(), Level::Info, "link_copied");
        } else {
            state.note(now_ms(), Level::Error, "clipboard_failed");
        }
    });
}

#[tauri::command]
fn retry_start(app: AppHandle) {
    // A refusal or a missing sidecar is launcher state, shown by the next snapshot.
    start_server(&app);
}

#[tauri::command]
fn confirm_exit(app: AppHandle) {
    request_stop(&app, StopPurpose::Quit);
}

pub fn run() {
    let app = tauri::Builder::default()
        // Registered first: a second launch only brings the existing window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Shared {
            state: Mutex::new(State::new(env!("CARGO_PKG_VERSION"))),
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
        })
        .manage(updater::UpdateShared::default())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            open_webui,
            copy_webui_url,
            retry_start,
            confirm_exit,
            updater::check_updates,
            updater::download_update,
            updater::install_update,
            updater::open_update_download
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                handle_quit_request(window.app_handle());
            }
        })
        .setup(|app| {
            // A failed start is shown in the panel with a retry button, not fatal here.
            start_server(app.handle());
            updater::initialize(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Lumo launcher");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<Shared>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                handle_quit_request(app);
            }
        }
    });
}
