// Misc bridge commands: import-folder scanning delegation, terminal
// drag-and-drop file staging, telemetry bootstrap, theme, window chrome
// (fullscreen/menu actions), notifications, and the Linux primary-selection
// clipboard.
//
// Ported from (semantics only):
//   - frontend/src/shared/telemetry.ts (telemetry bootstrap + install-id file)
//   - frontend/src/main.ts lines 385-392 (telemetry env defaults) and
//     1239-1355 (notifications, clipboard, saveDroppedFile, menu:action,
//     window:isFullScreen, theme:set)
//   - frontend/src/preload.ts (exact input/output shapes)
//
// NOTE: the action names accepted by `menu_action` intentionally do NOT match
// the legacy Electron `menu:action` string set (e.g. "window.minimize",
// "view.zoomIn") — this task's spec directs a fresh, flat naming scheme
// (minimize/maximize/close/quit/reload/toggle-devtools/zoom-in/zoom-out/
// zoom-reset/togglefullscreen/shell-focus) and explicitly defers the
// edit.* (undo/redo/cut/copy/paste/selectAll) roles to the renderer (M3), so
// unrecognized actions here are intentionally a logged no-op rather than an
// error.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Theme};

use crate::import_scan::{self, ScanOptions};
use crate::paths;

// ---------------------------------------------------------------------------
// app:scanImportFolder
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanImportFolderInput {
    pub path: String,
    pub mode: String,
}

#[tauri::command]
pub async fn app_scan_import_folder(
    input: ScanImportFolderInput,
) -> Result<serde_json::Value, String> {
    let home_dir = dirs::home_dir().map(|p| p.to_string_lossy().to_string());
    let result = import_scan::scan_import_folder(
        PathBuf::from(input.path),
        &input.mode,
        ScanOptions {
            env: None,
            home_dir,
        },
    )
    .await?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// terminal:saveDroppedFile
// ---------------------------------------------------------------------------

/// Port of the `/[^\w.-]+/g` → `_` regex replace in main.ts's
/// `terminal:saveDroppedFile` handler, collapsing runs of disallowed
/// characters into a single underscore (no `regex` crate dependency).
fn sanitize_dropped_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut out = String::new();
    let mut in_invalid_run = false;
    for c in base.chars() {
        let valid = c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-';
        if valid {
            out.push(c);
            in_invalid_run = false;
        } else if !in_invalid_run {
            out.push('_');
            in_invalid_run = true;
        }
    }
    if out.is_empty() {
        "dropped".to_string()
    } else {
        out
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn save_dropped_file(dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let base = sanitize_dropped_file_name(name);
    let target = dir.join(format!("{}-{base}", now_millis()));
    std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn terminal_save_dropped_file(name: String, bytes: Vec<u8>) -> Result<String, String> {
    let dir = paths::ao_data_dir().join("tauri").join("terminal-drops");
    save_dropped_file(&dir, &name, &bytes)
}

// ---------------------------------------------------------------------------
// telemetry:getBootstrap
// ---------------------------------------------------------------------------
//
// DEVIATION from the literal spec text: the spec describes this command's
// output as `{ key, host, appVersion, platform }` sourced from
// `AO_TELEMETRY_KEY`/`AO_TELEMETRY_HOST`. Neither those field names nor those
// env vars exist anywhere in the referenced source — the actual
// `TelemetryBootstrap` type (frontend/src/shared/telemetry.ts) and its only
// caller (`main.ts`'s `telemetry:getBootstrap` handler) produce
// `{ distinctId, appVersion, platform }`, where `distinctId` is a
// lazily-created id persisted under the telemetry data dir. This port follows
// the actual `TelemetryBootstrap` shape (the spec's own parenthetical says to
// "match TelemetryBootstrap field names"), not the parenthetical's example
// object.

fn telemetry_data_dir() -> Option<PathBuf> {
    // Mirrors `defaultDataDir`: an explicit AO_DATA_DIR is used verbatim
    // (already a full override, not joined with "data"); the home fallback
    // joins ".ao/data".
    if let Ok(dir) = std::env::var("AO_DATA_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    dirs::home_dir().map(|home| home.join(".ao").join("data"))
}

/// Port of `loadOrCreateTelemetryInstallId`. No `uuid` crate is available
/// (Cargo.toml is frozen for this task), so the id is a pid+timestamp token
/// in the same spirit as `daemon::DaemonStateInner`'s `app_run_id`.
fn load_or_create_telemetry_install_id(data_dir: &Path) -> Result<String, String> {
    let file = data_dir.join("telemetry_install_id");
    if let Ok(existing) = std::fs::read_to_string(&file) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let distinct_id = format!("ins_{}-{nanos}", std::process::id());
    std::fs::write(&file, format!("{distinct_id}\n")).map_err(|e| e.to_string())?;
    Ok(distinct_id)
}

fn node_style_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn build_telemetry_bootstrap(
    data_dir: Option<PathBuf>,
    app_version: &str,
) -> Result<Option<Value>, String> {
    let Some(data_dir) = data_dir else {
        return Ok(None);
    };
    let distinct_id = load_or_create_telemetry_install_id(&data_dir)?;
    Ok(Some(json!({
        "distinctId": distinct_id,
        "appVersion": app_version,
        "platform": node_style_platform(),
    })))
}

#[tauri::command]
pub async fn telemetry_get_bootstrap() -> Result<serde_json::Value, String> {
    let bootstrap = build_telemetry_bootstrap(telemetry_data_dir(), env!("CARGO_PKG_VERSION"))?;
    Ok(bootstrap.unwrap_or(Value::Null))
}

// ---------------------------------------------------------------------------
// theme:set
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn theme_set(app: AppHandle, theme: String) -> Result<(), String> {
    let resolved = match theme.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        "system" => None,
        _ => return Ok(()), // Unrecognized preference: ignore, mirroring main.ts's guard.
    };
    app.set_theme(resolved);
    Ok(())
}

// ---------------------------------------------------------------------------
// window:setOverlay — no-op; the custom titlebar (M3) handles overlay tinting
// itself instead of delegating to the OS titlebar-overlay API.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOverlayInput {
    #[allow(dead_code)]
    pub color: String,
    #[allow(dead_code)]
    pub symbol_color: String,
}

#[tauri::command]
pub async fn window_set_overlay(overlay: WindowOverlayInput) -> Result<(), String> {
    let _ = overlay;
    // custom titlebar handles overlay tinting (M3)
    Ok(())
}

// ---------------------------------------------------------------------------
// window:isFullScreen + window://fullscreen change notifications.
// ---------------------------------------------------------------------------

const MAIN_WINDOW_LABEL: &str = "main";

#[tauri::command]
pub async fn window_is_full_screen(app: AppHandle) -> Result<bool, String> {
    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => window.is_fullscreen().map_err(|e| e.to_string()),
        None => Ok(false),
    }
}

/// Tracks the last fullscreen state we emitted, so repeated `Resized` events
/// (which fire far more often than actual fullscreen toggles) only cause a
/// `window://fullscreen` emission when the value actually changed.
static LAST_FULLSCREEN: AtomicBool = AtomicBool::new(false);

/// Registers the window-event listener that backs `window://fullscreen`.
/// Tauri's `WindowEvent` has no dedicated fullscreen-changed variant, so this
/// piggybacks on `Resized` (fullscreen transitions always resize the window)
/// and re-checks `is_fullscreen()`, matching Electron's
/// `win.on("enter-full-screen"/"leave-full-screen")` behavior at the
/// event-emission boundary rather than the OS hook itself.
pub fn init(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    LAST_FULLSCREEN.store(window.is_fullscreen().unwrap_or(false), Ordering::SeqCst);
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Resized(_) = event {
            if let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) {
                if let Ok(fullscreen) = window.is_fullscreen() {
                    let previous = LAST_FULLSCREEN.swap(fullscreen, Ordering::SeqCst);
                    if previous != fullscreen {
                        let _ = app_handle.emit("window://fullscreen", fullscreen);
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// menu:action
// ---------------------------------------------------------------------------

/// Zoom scale factor persisted across zoom-in/zoom-out/zoom-reset calls
/// (Tauri's `set_zoom` is absolute, unlike Electron's relative
/// `setZoomLevel`); stored as bits-of-an-f64 in an AtomicU64 since there is
/// no atomic float type in std.
static ZOOM_SCALE_BITS: AtomicU64 = AtomicU64::new(0); // 0 => not yet initialized (defaults to 1.0)
const ZOOM_STEP: f64 = 0.1;
const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 3.0;

fn current_zoom() -> f64 {
    let bits = ZOOM_SCALE_BITS.load(Ordering::SeqCst);
    if bits == 0 {
        1.0
    } else {
        f64::from_bits(bits)
    }
}

fn set_zoom_scale(scale: f64) {
    ZOOM_SCALE_BITS.store(scale.to_bits(), Ordering::SeqCst);
}

#[tauri::command]
pub async fn menu_action(app: AppHandle, action: String) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };

    match action.as_str() {
        "minimize" => window.minimize().map_err(|e| e.to_string())?,
        "maximize" | "toggle-maximize" => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize().map_err(|e| e.to_string())?;
            } else {
                window.maximize().map_err(|e| e.to_string())?;
            }
        }
        "close" => window.close().map_err(|e| e.to_string())?,
        "quit" => app.exit(0),
        "reload" => window
            .eval("location.reload()")
            .map_err(|e| e.to_string())?,
        "toggle-devtools" => {
            #[cfg(debug_assertions)]
            {
                window.open_devtools();
            }
        }
        "zoom-in" => {
            let next = (current_zoom() + ZOOM_STEP).min(ZOOM_MAX);
            window.set_zoom(next).map_err(|e| e.to_string())?;
            set_zoom_scale(next);
        }
        "zoom-out" => {
            let next = (current_zoom() - ZOOM_STEP).max(ZOOM_MIN);
            window.set_zoom(next).map_err(|e| e.to_string())?;
            set_zoom_scale(next);
        }
        "zoom-reset" => {
            window.set_zoom(1.0).map_err(|e| e.to_string())?;
            set_zoom_scale(1.0);
        }
        "togglefullscreen" => {
            let fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
            window
                .set_fullscreen(!fullscreen)
                .map_err(|e| e.to_string())?;
        }
        "shell-focus" => {}
        other => {
            // Renderer handles edit roles (undo/redo/cut/copy/paste/selectAll)
            // itself — M3. Anything else unrecognized is a no-op.
            eprintln!("misc::menu_action: unrecognized action {other:?}");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// notifications:show
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationInput {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
}

#[tauri::command]
pub async fn notifications_show(
    app: AppHandle,
    notification: NotificationInput,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    if notification.id.is_empty() || notification.title.is_empty() {
        return Ok(());
    }
    let mut builder = app.notification().builder().title(notification.title);
    if let Some(body) = notification.body {
        builder = builder.body(body);
    }
    // NOTE: tauri-plugin-notification's Rust API has no click-callback hook
    // (unlike Electron's `Notification#on("click", ...)`), so
    // "notifications://click" is never emitted here; the renderer already
    // tolerates a notification that never reports a click.
    builder.show().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// clipboard:writePrimary — Linux-only X11/Wayland primary selection.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn clipboard_write_primary(text: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use arboard::{Clipboard, LinuxClipboardKind, SetExtLinux};
        let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
        clipboard
            .set()
            .clipboard(LinuxClipboardKind::Primary)
            .text(text)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = text;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// app:getVersion
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn app_get_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    mod sanitize_dropped_file_name_tests {
        use super::*;

        #[test]
        fn strips_path_separators_and_keeps_word_dot_dash_chars() {
            assert_eq!(sanitize_dropped_file_name("../../etc/passwd"), "passwd");
            assert_eq!(
                sanitize_dropped_file_name("weird name!!.png"),
                "weird_name_.png"
            );
            assert_eq!(
                sanitize_dropped_file_name("C:\\Users\\me\\file.txt"),
                "file.txt"
            );
        }

        #[test]
        fn falls_back_to_dropped_when_nothing_survives() {
            assert_eq!(sanitize_dropped_file_name("///"), "dropped");
            assert_eq!(sanitize_dropped_file_name(""), "dropped");
        }
    }

    mod save_dropped_file_tests {
        use super::*;

        #[test]
        fn writes_bytes_under_a_timestamp_prefixed_name_and_returns_the_absolute_path() {
            let dir = tempdir("ao-terminal-drops");
            let path = save_dropped_file(&dir, "clip.png", b"hello").unwrap();
            let written = std::fs::read(&path).unwrap();
            assert_eq!(written, b"hello");
            assert!(Path::new(&path).is_absolute());
            let file_name = Path::new(&path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();
            assert!(file_name.ends_with("-clip.png"));
        }

        #[test]
        fn creates_the_destination_directory_when_missing() {
            let dir = tempdir("ao-terminal-drops-missing").join("nested");
            let path = save_dropped_file(&dir, "a.txt", b"x").unwrap();
            assert!(Path::new(&path).exists());
        }
    }

    mod telemetry_bootstrap_tests {
        use super::*;

        #[test]
        fn returns_none_when_no_data_dir_is_available() {
            assert_eq!(build_telemetry_bootstrap(None, "1.2.3").unwrap(), None);
        }

        #[test]
        fn creates_and_persists_a_distinct_id_on_first_use() {
            let dir = tempdir("ao-telemetry-bootstrap");
            let bootstrap = build_telemetry_bootstrap(Some(dir.clone()), "1.2.3")
                .unwrap()
                .unwrap();
            assert_eq!(bootstrap["appVersion"], json!("1.2.3"));
            assert!(bootstrap["distinctId"]
                .as_str()
                .unwrap()
                .starts_with("ins_"));
            let install_id_file = dir.join("telemetry_install_id");
            assert!(install_id_file.exists());
        }

        #[test]
        fn reuses_an_existing_distinct_id_across_calls() {
            let dir = tempdir("ao-telemetry-bootstrap-reuse");
            let first = build_telemetry_bootstrap(Some(dir.clone()), "1.0.0")
                .unwrap()
                .unwrap();
            let second = build_telemetry_bootstrap(Some(dir.clone()), "1.0.0")
                .unwrap()
                .unwrap();
            assert_eq!(first["distinctId"], second["distinctId"]);
        }
    }

    mod zoom_tests {
        use super::*;

        #[test]
        fn defaults_to_1_0_until_set_and_round_trips_through_the_atomic() {
            ZOOM_SCALE_BITS.store(0, Ordering::SeqCst);
            assert_eq!(current_zoom(), 1.0);
            set_zoom_scale(1.5);
            assert_eq!(current_zoom(), 1.5);
            ZOOM_SCALE_BITS.store(0, Ordering::SeqCst);
        }
    }
}
