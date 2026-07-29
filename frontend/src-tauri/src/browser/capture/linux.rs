// Linux (webkit2gtk) native history control, following the same "initiate on
// main, never block main waiting for an async completion" contract proven by
// the macOS spike (see `browser/mod.rs` module doc and `capture::macos`).
//
// DEVIATION (documented, see T9 execution report): JPEG capture
// (`webkit2gtk::WebView::snapshot`, itself async-via-callback like WKWebView's
// snapshot) is intentionally left unimplemented here. This file is
// `cfg(target_os = "linux")`-gated out of every `cargo check` run on this
// (macOS) host, so nothing here — including the synchronous
// `WebViewExt`-based nav-control methods below — has been compiler-verified;
// treat it as a starting point for a Linux CI pass, not proven code.
#![cfg(target_os = "linux")]

use webkit2gtk::WebViewExt;

fn on_main<T: Send + 'static>(
    webview: &tauri::Webview,
    f: impl FnOnce(&webkit2gtk::WebView) -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel::<T>();
    webview
        .with_webview(move |pw| {
            let view = pw.inner();
            let _ = tx.send(f(&view));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())
}

pub fn history_state_blocking(
    webview: &tauri::Webview,
    _timeout: std::time::Duration,
) -> Result<(bool, bool), String> {
    on_main(webview, |view| (view.can_go_back(), view.can_go_forward()))
}

pub fn go_back(webview: &tauri::Webview) {
    let _ = on_main(webview, |view| view.go_back());
}

pub fn go_forward(webview: &tauri::Webview) {
    let _ = on_main(webview, |view| view.go_forward());
}

pub fn stop_loading(webview: &tauri::Webview) {
    let _ = on_main(webview, |view| view.stop_loading());
}

pub fn snapshot_jpeg_blocking(_webview: &tauri::Webview, _timeout: std::time::Duration) -> Result<Vec<u8>, String> {
    Err("browser panel JPEG capture is not yet implemented on Linux".to_string())
}

pub const SUPPORTED: bool = false;
