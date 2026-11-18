//! Confirmed in-app updates: check the signed feed, download and verify only on request, then
//! stop the sidecar through the normal shutdown path before installing.
//!
//! This adapter owns the plugin resources and the network. Which update actions are allowed,
//! what the panel sees, and when the app may exit belong to [`crate::launcher::State`].

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::launcher::{CheckResourcePlan, DownloadResourcePlan, InstallMode, StopPurpose};

const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;
const REQUEST_TIMEOUT_SECS: u64 = 30;
const RELEASES_TAG: &str = "https://github.com/oOSomnus/lumo/releases/tag/";

struct Pending {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct Inner {
    available: Option<Update>,
    pending: Option<Pending>,
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

pub(crate) fn install_mode() -> InstallMode {
    match tauri::utils::platform::bundle_type() {
        Some(
            tauri::utils::config::BundleType::Nsis
            | tauri::utils::config::BundleType::App
            | tauri::utils::config::BundleType::AppImage,
        ) => InstallMode::InApp,
        _ => InstallMode::Download,
    }
}

/// Puts the panel at its starting point and schedules the startup check plus daily checks.
pub fn initialize(app: &AppHandle) {
    if !crate::update_updater(app, |state| state.initialize_updates()) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            check(handle.clone()).await;
            tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        }
    });
}

async fn check(app: AppHandle) {
    let admitted = {
        let shared = app.state::<UpdateShared>();
        let inner = lock(&shared.inner);
        crate::update_updater(&app, |state| {
            state.begin_update_check(inner.pending.is_some())
        })
    };
    if !admitted {
        return;
    }

    let result = match app
        .updater_builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
    {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let (summary, update) = match result {
        Ok(Some(update)) => (Ok(Some(update.version.clone())), Some(update)),
        Ok(None) => (Ok(None), None),
        Err(_) => (Err(()), None),
    };

    let shared = app.state::<UpdateShared>();
    let mut inner = lock(&shared.inner);
    match crate::update_updater(&app, |state| state.finish_update_check(summary)) {
        CheckResourcePlan::StoreAvailable => {
            if let Some(update) = update {
                inner.available = Some(update);
            }
        }
        CheckResourcePlan::ClearAvailable => inner.available = None,
        CheckResourcePlan::KeepAvailable => {}
    }
}

async fn download(app: AppHandle) {
    let (admitted, update) = {
        let shared = app.state::<UpdateShared>();
        let inner = lock(&shared.inner);
        let available = inner.available.as_ref().map(|update| update.version.clone());
        let admitted = crate::update_updater(&app, |state| {
            state.begin_update_download(available.as_deref(), inner.pending.is_some())
        });
        (admitted, inner.available.clone())
    };
    if !admitted {
        return;
    }
    let Some(update) = update else {
        return;
    };

    let version = update.version.clone();
    let bytes = update.download(|_, _| {}, || {}).await.ok();
    let shared = app.state::<UpdateShared>();
    let mut inner = lock(&shared.inner);
    let plan = crate::update_updater(&app, |state| {
        state.finish_update_download(version.clone(), bytes.is_some())
    });
    if plan == DownloadResourcePlan::StorePending {
        if let Some(bytes) = bytes {
            inner.available = None;
            inner.pending = Some(Pending { update, bytes });
        }
    }
}

fn install(app: AppHandle) {
    if !crate::update_updater(&app, |state| state.can_install_update()) {
        return;
    }
    let admitted = {
        let shared = app.state::<UpdateShared>();
        let inner = lock(&shared.inner);
        let pending = inner
            .pending
            .as_ref()
            .map(|pending| pending.update.version.clone());
        crate::update_updater(&app, |state| {
            state.begin_update_install(pending.as_deref())
        })
    };
    if !admitted {
        return;
    }
    // A separate operation: a quit accepted in between keeps its purpose.
    crate::request_stop(&app, StopPurpose::Update);
}

/// Called once the sidecar stopped cleanly, or immediately when there was none.
pub fn install_pending(app: &AppHandle) {
    let Some(pending) = take_pending(app) else {
        return;
    };
    let version = Some(pending.update.version.clone());
    crate::update_updater(app, |state| state.show_update_installing(version.clone()));
    crate::update_updater(app, |state| state.set_exit_allowed(true));
    match pending.update.install(&pending.bytes) {
        Ok(()) => {
            #[cfg(not(windows))]
            app.restart();
        }
        Err(_) => {
            crate::update_updater(app, |state| state.set_exit_allowed(false));
            {
                let shared = app.state::<UpdateShared>();
                let mut inner = lock(&shared.inner);
                inner.available = Some(pending.update);
            }
            crate::update_updater(app, |state| state.finish_update_install(version));
            crate::update_updater(app, |state| state.update_install_failed());
        }
    }
}

fn take_pending(app: &AppHandle) -> Option<Pending> {
    lock(&app.state::<UpdateShared>().inner).pending.take()
}

/// The sidecar could not reach a clean stop; keep the downloaded update for another attempt.
pub fn shutdown_failed(app: &AppHandle) {
    let shared = app.state::<UpdateShared>();
    let inner = lock(&shared.inner);
    let version = inner
        .pending
        .as_ref()
        .map(|pending| pending.update.version.clone());
    drop(inner);
    crate::update_updater(app, |state| state.update_shutdown_failed(version));
}

fn open_download(app: &AppHandle) {
    let shared = app.state::<UpdateShared>();
    let inner = lock(&shared.inner);
    let pending = inner
        .pending
        .as_ref()
        .map(|pending| pending.update.version.as_str());
    let available = inner
        .available
        .as_ref()
        .map(|update| update.version.as_str());
    let version = crate::update_updater(app, |state| {
        state
            .update_download_version(pending, available)
            .map(str::to_owned)
    });
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
