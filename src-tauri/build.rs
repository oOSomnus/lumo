fn main() {
    // Only these commands are reachable from the panel (see capabilities/main.json).
    let app = tauri_build::AppManifest::new().commands(&[
        "get_snapshot",
        "open_webui",
        "copy_webui_url",
        "retry_start",
        "confirm_exit",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app))
        .expect("failed to run tauri-build");
}
