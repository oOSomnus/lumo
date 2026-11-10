//! Confirmed in-app updates: check the signed feed, download and verify only on request, then
//! stop the sidecar through the normal shutdown path before installing.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::launcher::{Phase, StopPurpose};

const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;
const REQUEST_TIMEOUT_SECS: u64 = 30;
const RELEASES_TAG: &str = "https://github.com/oOSomnus/lumo/releases/tag/";

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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateState {
    pub phase: UpdatePhase,
    pub version: Option<String>,
    pub install_mode: InstallMode,
    pub error_code: Option<UpdateError>,
}

impl LauncherUpdateState {
    /// The panel shows nothing for an updater that this build cannot use.
    pub fn disabled() -> Self {
        Self {
            phase: UpdatePhase::Disabled,
            version: None,
            install_mode: install_mode(),
            error_code: None,
        }
    }

    fn at(phase: UpdatePhase, version: Option<String>, error: Option<UpdateError>) -> Self {
        Self {
            phase,
            version,
            install_mode: install_mode(),
            error_code: error,
        }
    }
}

struct Pending {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct Inner {
    available: Option<Update>,
    pending: Option<Pending>,
    checking: bool,
    downloading: bool,
    installing: bool,
}

/// The one checked update and the verified bytes; never exposed through the panel snapshot.
#[derive(Default)]
pub struct UpdateShared {
    inner: Mutex<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A build without embedded update signing keys, or a development build, never checks the network.
pub fn enabled() -> bool {
    !cfg!(debug_assertions)
        && option_env!("LUMO_UPDATER_PUBLIC_KEY").is_some_and(|key| !key.is_empty())
}

fn install_mode() -> InstallMode {
    match tauri::utils::platform::bundle_type() {
        Some(
            tauri::utils::config::BundleType::Nsis
            | tauri::utils::config::BundleType::App
            | tauri::utils::config::BundleType::AppImage,
        ) => InstallMode::InApp,
        _ => InstallMode::Download,
    }
}

fn publish(app: &AppHandle, state: LauncherUpdateState) {
    crate::set_update_state(app, state);
}

fn current_version(app: &AppHandle) -> Option<String> {
    Some(app.package_info().version.to_string())
}

/// Puts the panel at its starting point and schedules the startup check plus daily checks.
pub fn initialize(app: &AppHandle) {
    if !enabled() {
        publish(app, LauncherUpdateState::disabled());
        return;
    }
    publish(
        app,
        LauncherUpdateState::at(UpdatePhase::Idle, current_version(app), None),
    );
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            check(handle.clone()).await;
            tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        }
    });
}

async fn check(app: AppHandle) {
    if !enabled() {
        return;
    }
    {
        let shared = app.state::<UpdateShared>();
        let mut inner = lock(&shared.inner);
        if inner.checking || inner.downloading || inner.installing || inner.pending.is_some() {
            return;
        }
        inner.checking = true;
    }
    publish(
        &app,
        LauncherUpdateState::at(UpdatePhase::Checking, current_version(&app), None),
    );
    let result = match app
        .updater_builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
    {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let stopping = crate::launcher_phase(&app) == Phase::Stopping;
    let shared = app.state::<UpdateShared>();
    let mut inner = lock(&shared.inner);
    inner.checking = false;
    if stopping {
        inner.available = None;
        return;
    }
    match result {
        Ok(Some(update)) => {
            let version = Some(update.version.clone());
            inner.available = Some(update);
            publish(
                &app,
                LauncherUpdateState::at(UpdatePhase::Available, version, None),
            );
        }
        Ok(None) => {
            inner.available = None;
            publish(
                &app,
                LauncherUpdateState::at(UpdatePhase::Current, current_version(&app), None),
            );
        }
        Err(_) => publish(
            &app,
            LauncherUpdateState::at(
                UpdatePhase::Failed,
                current_version(&app),
                Some(UpdateError::CheckFailed),
            ),
        ),
    }
}

async fn download(app: AppHandle) {
    if !enabled() {
        return;
    }
    let update = {
        let shared = app.state::<UpdateShared>();
        let mut inner = lock(&shared.inner);
        if inner.downloading || inner.installing || inner.pending.is_some() {
            return;
        }
        let Some(update) = inner.available.clone() else {
            return;
        };
        inner.downloading = true;
        update
    };
    let version = Some(update.version.clone());
    publish(
        &app,
        LauncherUpdateState::at(UpdatePhase::Downloading, version.clone(), None),
    );
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .ok();
    let stopping = crate::launcher_phase(&app) == Phase::Stopping;
    let shared = app.state::<UpdateShared>();
    let mut inner = lock(&shared.inner);
    inner.downloading = false;
    if stopping {
        return;
    }
    match bytes {
        Some(bytes) => {
            inner.available = None;
            inner.pending = Some(Pending { update, bytes });
            publish(&app, LauncherUpdateState::at(UpdatePhase::Ready, version, None));
        }
        None => publish(
            &app,
            LauncherUpdateState::at(
                UpdatePhase::Failed,
                version,
                Some(UpdateError::DownloadFailed),
            ),
        ),
    }
}

fn install(app: AppHandle) {
    if !enabled() || install_mode() != InstallMode::InApp {
        return;
    }
    if crate::launcher_phase(&app) == Phase::Stopping {
        return;
    }
    {
        let shared = app.state::<UpdateShared>();
        let mut inner = lock(&shared.inner);
        if inner.installing || inner.pending.is_none() {
            return;
        }
        inner.installing = true;
    }
    let version = lock(&app.state::<UpdateShared>().inner)
        .pending
        .as_ref()
        .map(|pending| pending.update.version.clone());
    publish(
        &app,
        LauncherUpdateState::at(UpdatePhase::Installing, version, None),
    );
    crate::request_stop(&app, StopPurpose::Update);
}

/// Called once the sidecar stopped cleanly, or immediately when there was none.
pub fn install_pending(app: &AppHandle) {
    let Some(pending) = take_pending(app) else {
        return;
    };
    let version = Some(pending.update.version.clone());
    publish(
        app,
        LauncherUpdateState::at(UpdatePhase::Installing, version.clone(), None),
    );
    crate::set_quitting(app, true);
    match pending.update.install(&pending.bytes) {
        Ok(()) => {
            #[cfg(not(windows))]
            app.restart();
        }
        Err(_) => {
            crate::set_quitting(app, false);
            let shared = app.state::<UpdateShared>();
            let mut inner = lock(&shared.inner);
            inner.installing = false;
            inner.available = Some(pending.update);
            drop(inner);
            publish(
                app,
                LauncherUpdateState::at(
                    UpdatePhase::Failed,
                    version,
                    Some(UpdateError::InstallFailed),
                ),
            );
            crate::update_install_failed(app);
        }
    }
}

fn take_pending(app: &AppHandle) -> Option<Pending> {
    lock(&app.state::<UpdateShared>().inner).pending.take()
}

/// The sidecar could not reach a clean stop; keep the downloaded update for another attempt.
pub fn shutdown_failed(app: &AppHandle) {
    let shared = app.state::<UpdateShared>();
    let mut inner = lock(&shared.inner);
    inner.installing = false;
    let version = inner
        .pending
        .as_ref()
        .map(|pending| pending.update.version.clone());
    drop(inner);
    publish(
        app,
        LauncherUpdateState::at(
            UpdatePhase::Failed,
            version,
            Some(UpdateError::ShutdownFailed),
        ),
    );
}

fn open_download(app: &AppHandle) {
    if install_mode() != InstallMode::Download {
        return;
    }
    let shared = app.state::<UpdateShared>();
    let inner = lock(&shared.inner);
    let version = inner
        .pending
        .as_ref()
        .map(|pending| pending.update.version.clone())
        .or_else(|| inner.available.as_ref().map(|update| update.version.clone()));
    drop(inner);
    let Some(version) = version else {
        return;
    };
    let Ok(url) = Url::parse(&format!("{RELEASES_TAG}v{version}")) else {
        return;
    };
    let _ = app.opener().open_url(url, None::<&str>);
}

#[tauri::command]
pub async fn check_updates(app: AppHandle) {
    check(app).await;
}

#[tauri::command]
pub async fn download_update(app: AppHandle) {
    download(app).await;
}

#[tauri::command]
pub fn install_update(app: AppHandle) {
    install(app);
}

#[tauri::command]
pub fn open_update_download(app: AppHandle) {
    open_download(&app);
}
