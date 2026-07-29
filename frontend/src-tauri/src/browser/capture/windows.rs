// Windows native history control, following the same "initiate on main,
// never block main waiting for an async completion" contract proven by the
// macOS spike (see `browser/mod.rs` module doc and `capture::macos`).
//
// DEVIATION (documented, see T9 execution report): JPEG capture
// (`ICoreWebView2::CapturePreview`, which — like WKWebView's snapshot — is
// itself async-via-completion-handler) is intentionally left unimplemented
// here. Implementing it correctly requires a COM `IStream` + a
// `ICoreWebView2CapturePreviewCompletedHandler` callback object, which this
// pass could not compile-check: `cargo check` on this (macOS) host never
// compiles this file (it is `cfg(target_os = "windows")`-gated out), so
// nothing beyond the synchronous, well-documented `ICoreWebView2`
// nav-control methods below should be trusted without a Windows CI run.
#![cfg(target_os = "windows")]

use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

fn core_webview2(webview: &tauri::Webview) -> Result<ICoreWebView2, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<ICoreWebView2, String>>();
    webview
        .with_webview(move |pw| {
            let controller = pw.controller();
            let core = unsafe { controller.CoreWebView2() }.map_err(|e| e.to_string());
            let _ = tx.send(core);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?
}

pub fn history_state_blocking(
    webview: &tauri::Webview,
    _timeout: std::time::Duration,
) -> Result<(bool, bool), String> {
    let core = core_webview2(webview)?;
    let can_back = unsafe { core.CanGoBack() }
        .map_err(|e| e.to_string())?
        .as_bool();
    let can_forward = unsafe { core.CanGoForward() }
        .map_err(|e| e.to_string())?
        .as_bool();
    Ok((can_back, can_forward))
}

pub fn go_back(webview: &tauri::Webview) {
    if let Ok(core) = core_webview2(webview) {
        let _ = unsafe { core.GoBack() };
    }
}

pub fn go_forward(webview: &tauri::Webview) {
    if let Ok(core) = core_webview2(webview) {
        let _ = unsafe { core.GoForward() };
    }
}

pub fn stop_loading(webview: &tauri::Webview) {
    if let Ok(core) = core_webview2(webview) {
        let _ = unsafe { core.Stop() };
    }
}

pub fn snapshot_jpeg_blocking(
    _webview: &tauri::Webview,
    _timeout: std::time::Duration,
) -> Result<Vec<u8>, String> {
    Err("browser panel JPEG capture is not yet implemented on Windows".to_string())
}

pub const SUPPORTED: bool = false;
