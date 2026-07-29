// T9 spike (macOS only): prove that a child webview created via
// `Window::add_child` can be snapshotted through WKWebView's
// `takeSnapshotWithConfiguration:completionHandler:` and turned into JPEG
// bytes. This file is intentionally throwaway scaffolding for the spike gate
// described in tasks/specs/T9-browser-panel.md step 1; the real
// implementation lives in `browser/capture/macos.rs`.
//
// Concurrency contract (load-bearing for the real implementation): the
// snapshot is INITIATED on the main thread (with_webview) and the completion
// handler is delivered by WebKit on the main run loop — so the caller must
// NEVER block the main thread waiting for it. Initiate on main, receive the
// bytes on a background thread.
#![cfg(target_os = "macos")]

use std::sync::mpsc::{channel, Sender};
use std::time::Instant;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::NSImage;
use objc2_foundation::MainThreadMarker;
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
use tauri::webview::WebviewBuilder;
use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

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
    let decoded = image::load_from_memory_with_format(tiff, image::ImageFormat::Tiff)
        .map_err(|e| e.to_string())?;
    let mut jpeg_bytes: Vec<u8> = Vec::new();
    decoded
        .write_to(
            &mut std::io::Cursor::new(&mut jpeg_bytes),
            image::ImageFormat::Jpeg,
        )
        .map_err(|e| e.to_string())?;
    Ok(jpeg_bytes)
}

/// Called from a BACKGROUND thread: schedules `begin_snapshot` on the main
/// thread via `with_webview`, then waits for the TIFF bytes here — off the
/// main thread — so the run loop stays free to deliver the completion.
fn snapshot_jpeg_blocking(
    child: &tauri::webview::Webview,
    timeout: std::time::Duration,
) -> Result<Vec<u8>, String> {
    let (tx, rx) = channel::<Result<Vec<u8>, String>>();
    child
        .with_webview(move |pw| {
            let view: &WKWebView = unsafe { &*pw.inner().cast() };
            begin_snapshot(view, tx);
        })
        .map_err(|e| e.to_string())?;
    let tiff = rx.recv_timeout(timeout).map_err(|e| e.to_string())??;
    tiff_to_jpeg(&tiff)
}

/// Debug-only command: creates a child webview navigated to a real page,
/// waits briefly for it to render, then takes 10 consecutive WKWebView
/// snapshots and reports the resulting data URL (first frame) plus timing so
/// the caller can compute fps. Must be invoked from a background thread.
#[tauri::command]
pub fn browser_capture_spike(window: tauri::Window) -> Result<serde_json::Value, String> {
    let child = window
        .add_child(
            WebviewBuilder::new(
                "browser-spike",
                WebviewUrl::External("https://example.com".parse().unwrap()),
            ),
            LogicalPosition::new(20.0, 20.0),
            LogicalSize::new(800.0, 600.0),
        )
        .map_err(|e| e.to_string())?;

    // Give the page a moment to load before snapshotting.
    std::thread::sleep(std::time::Duration::from_millis(4000));

    // Cold-start warmup: the first WKWebView snapshot on a freshly created
    // webview pays a one-time GPU/compositor warmup cost far above steady
    // state, so it is not counted toward the reported fps below.
    let _ = snapshot_jpeg_blocking(&child, std::time::Duration::from_secs(20))?;

    let mut durations_ms: Vec<f64> = Vec::new();
    let mut first_data_url: Option<String> = None;
    let mut byte_len = 0usize;

    for i in 0..10 {
        let start = Instant::now();
        let bytes = snapshot_jpeg_blocking(&child, std::time::Duration::from_secs(10))?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        eprintln!("SPIKE_DEBUG iter {} took {:.1}ms", i, elapsed);
        durations_ms.push(elapsed);
        if i == 0 {
            byte_len = bytes.len();
            first_data_url = Some(format!("data:image/jpeg;base64,{}", base64_encode(&bytes)));
        }
    }

    let total_ms: f64 = durations_ms.iter().sum();
    let fps = if total_ms > 0.0 {
        10.0 / (total_ms / 1000.0)
    } else {
        0.0
    };

    Ok(serde_json::json!({
        "dataUrlLen": first_data_url.as_ref().map(|s| s.len()).unwrap_or(0),
        "jpegBytes": byte_len,
        "fps": fps,
        "durationsMs": durations_ms,
        "dataUrlPrefix": first_data_url.map(|s| s.chars().take(64).collect::<String>()),
    }))
}

fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
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
