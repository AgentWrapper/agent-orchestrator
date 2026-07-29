// Platform capture/history-control dispatch. Each platform module follows
// the concurrency contract documented in `browser/mod.rs` and proven by the
// (now-deleted) macOS spike: initiate any native async call on the main
// thread via `with_webview`, wait for the result only on a background
// thread/task.

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

use std::time::Duration;

use tauri::State;

use super::BrowserRegistry;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);

/// True when this platform has a real JPEG-capture implementation (see the
/// per-platform DEVIATION notes for windows/linux — only macOS is
/// spike-proven and ported).
pub fn platform_capture_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::SUPPORTED
    }
    #[cfg(target_os = "windows")]
    {
        windows::SUPPORTED
    }
    #[cfg(target_os = "linux")]
    {
        linux::SUPPORTED
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        false
    }
}

pub fn snapshot_jpeg_blocking(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::snapshot_jpeg_blocking(webview, SNAPSHOT_TIMEOUT)
    }
    #[cfg(target_os = "windows")]
    {
        windows::snapshot_jpeg_blocking(webview, SNAPSHOT_TIMEOUT)
    }
    #[cfg(target_os = "linux")]
    {
        linux::snapshot_jpeg_blocking(webview, SNAPSHOT_TIMEOUT)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = webview;
        Err("browser panel capture is not supported on this platform".to_string())
    }
}

pub fn history_state_blocking(webview: &tauri::Webview) -> Result<(bool, bool), String> {
    #[cfg(target_os = "macos")]
    {
        macos::history_state_blocking(webview, SNAPSHOT_TIMEOUT)
    }
    #[cfg(target_os = "windows")]
    {
        windows::history_state_blocking(webview, SNAPSHOT_TIMEOUT)
    }
    #[cfg(target_os = "linux")]
    {
        linux::history_state_blocking(webview, SNAPSHOT_TIMEOUT)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = webview;
        Ok((false, false))
    }
}

pub fn go_back(webview: &tauri::Webview) {
    #[cfg(target_os = "macos")]
    macos::go_back(webview);
    #[cfg(target_os = "windows")]
    windows::go_back(webview);
    #[cfg(target_os = "linux")]
    linux::go_back(webview);
}

pub fn go_forward(webview: &tauri::Webview) {
    #[cfg(target_os = "macos")]
    macos::go_forward(webview);
    #[cfg(target_os = "windows")]
    windows::go_forward(webview);
    #[cfg(target_os = "linux")]
    linux::go_forward(webview);
}

pub fn stop_loading(webview: &tauri::Webview) {
    #[cfg(target_os = "macos")]
    macos::stop_loading(webview);
    #[cfg(target_os = "windows")]
    windows::stop_loading(webview);
    #[cfg(target_os = "linux")]
    linux::stop_loading(webview);
}

// No base64 crate is declared in Cargo.toml for this task (only the
// platform-gated native deps listed in tasks/specs/T9-browser-panel.md are),
// so this reuses the small hand-rolled encoder proven in the spike rather
// than adding a new top-level dependency.
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(CHARS[(b0 >> 2) as usize] as char);
        out.push(CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            CHARS[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            CHARS[(b2 & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn jpeg_data_url(bytes: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", base64_encode(bytes))
}

/// `browser_capture` — same string-shape contract as Electron's
/// `capturePage` path (`data:image/jpeg;base64,...`, or `""` on failure/no
/// entry), byte-for-byte matching `AoBridge["browser"]["capture"]`.
//
// MUST be `#[tauri::command(async)]` (tasks/specs/T9b-browser-panel-fixes.md
// fix 2, and the concurrency contract in `browser/mod.rs`'s module doc): a
// plain (non-`async`-attributed) `#[tauri::command]` runs INLINE, on
// whatever thread delivered the IPC message (the main/webview thread) —
// Tauri only dispatches onto a separate runtime task when the command is
// `async`. `snapshot_jpeg_blocking`'s `recv_timeout` wait can only be
// satisfied by a completion handler delivered on the main run loop (see
// `capture::macos::snapshot_jpeg_blocking`), so calling it inline on that
// same thread previously self-deadlocked for up to `SNAPSHOT_TIMEOUT` (5s)
// before falling back to an empty string. Marking the command `async` moves
// the call (and its blocking wait) onto Tauri's async runtime instead,
// leaving the main thread free to deliver the completion.
#[tauri::command(async)]
pub fn browser_capture(
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    view_id: String,
) -> Result<String, String> {
    let known = state.0.lock().unwrap().contains_key(&view_id);
    if !known {
        return Ok(String::new());
    }
    let Some(webview) = tauri::Manager::get_webview(&app, &view_id) else {
        return Ok(String::new());
    };
    Ok(snapshot_jpeg_blocking(&webview)
        .map(|bytes| jpeg_data_url(&bytes))
        .unwrap_or_default())
}
