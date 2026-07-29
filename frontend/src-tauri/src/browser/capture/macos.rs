// macOS native capture + history control, ported from the approved spike
// (`git show a7b23fbdf:frontend/src-tauri/src/browser_spike.rs`,
// ~19-25ms/snapshot, ~50fps in release — see tasks/specs/T9-browser-panel.md
// header for the full readout). `snapshot_jpeg_blocking` is the reference
// pattern the other two platform modules follow.
#![cfg(target_os = "macos")]

use std::sync::mpsc::{channel, Sender};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::NSImage;
use objc2_foundation::MainThreadMarker;
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

/// Runs on the MAIN thread: kicks off the snapshot and returns immediately.
/// The completion handler (also main thread) converts to TIFF bytes and sends
/// them through `tx`; the receiving end must live on a background thread.
fn begin_snapshot(webview: &WKWebView, tx: Sender<Result<Vec<u8>, String>>) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = tx.send(Err("must run on main thread".into()));
        return;
    };
    let config = unsafe { WKSnapshotConfiguration::new(mtm) };
    let block = RcBlock::new(move |image: *mut NSImage, error: *mut objc2_foundation::NSError| {
        let result = if !image.is_null() {
            let image = unsafe { Retained::retain(image) }.unwrap();
            match image.TIFFRepresentation() {
                Some(tiff) => Ok(tiff.to_vec()),
                None => Err("no TIFF representation".to_string()),
            }
        } else if !error.is_null() {
            Err(unsafe { &*error }.to_string())
        } else {
            Err("unknown snapshot error".to_string())
        };
        let _ = tx.send(result);
    });
    unsafe {
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
    }
}

fn tiff_to_jpeg(tiff: &[u8]) -> Result<Vec<u8>, String> {
    let decoded = image::load_from_memory_with_format(tiff, image::ImageFormat::Tiff).map_err(|e| e.to_string())?;
    let mut jpeg_bytes: Vec<u8> = Vec::new();
    decoded
        .write_to(&mut std::io::Cursor::new(&mut jpeg_bytes), image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(jpeg_bytes)
}

/// Called from a BACKGROUND thread/task: schedules `begin_snapshot` on the
/// main thread via `with_webview`, then waits for the TIFF bytes here — off
/// the main thread — so the run loop stays free to deliver the completion.
/// This is the load-bearing concurrency contract for every native async call
/// in this module (see `browser/mod.rs` module doc).
pub fn snapshot_jpeg_blocking(webview: &tauri::Webview, timeout: Duration) -> Result<Vec<u8>, String> {
    let (tx, rx) = channel::<Result<Vec<u8>, String>>();
    webview
        .with_webview(move |pw| {
            let view: &WKWebView = unsafe { &*pw.inner().cast() };
            begin_snapshot(view, tx);
        })
        .map_err(|e| e.to_string())?;
    let tiff = rx.recv_timeout(timeout).map_err(|e| e.to_string())??;
    tiff_to_jpeg(&tiff)
}

/// Synchronous WKWebView properties (canGoBack/canGoForward) are safe to read
/// on the main thread without a completion handler, but `with_webview` still
/// only runs its closure there — so the read is dispatched the same way as
/// the async snapshot, just without a completion handler round trip. The
/// wait for the channel still only ever blocks the calling BACKGROUND
/// thread/task, never main.
pub fn history_state_blocking(webview: &tauri::Webview, timeout: Duration) -> Result<(bool, bool), String> {
    let (tx, rx) = channel::<(bool, bool)>();
    webview
        .with_webview(move |pw| {
            let view: &WKWebView = unsafe { &*pw.inner().cast() };
            let can_back = unsafe { view.canGoBack() };
            let can_forward = unsafe { view.canGoForward() };
            let _ = tx.send((can_back, can_forward));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(timeout).map_err(|e| e.to_string())
}

/// Fire-and-forget native navigation controls — mirrors Electron's
/// `contents.goBack()`/`goForward()`/`stop()`, which do not await a result
/// either; the subsequent nav-state refresh (did-navigate/title-changed
/// equivalents) is what pushes the updated state to the renderer.
pub fn go_back(webview: &tauri::Webview) {
    let _ = webview.with_webview(|pw| {
        let view: &WKWebView = unsafe { &*pw.inner().cast() };
        unsafe { view.goBack() };
    });
}

pub fn go_forward(webview: &tauri::Webview) {
    let _ = webview.with_webview(|pw| {
        let view: &WKWebView = unsafe { &*pw.inner().cast() };
        unsafe { view.goForward() };
    });
}

pub fn stop_loading(webview: &tauri::Webview) {
    let _ = webview.with_webview(|pw| {
        let view: &WKWebView = unsafe { &*pw.inner().cast() };
        unsafe { view.stopLoading() };
    });
}

pub const SUPPORTED: bool = true;
