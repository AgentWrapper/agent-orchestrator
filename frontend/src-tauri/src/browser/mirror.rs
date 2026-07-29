// Mirror-by-snapshot-streaming (spec step 8): a background loop that
// repeatedly captures a JPEG via `capture::snapshot_jpeg_blocking` (5-10fps)
// and serves the latest frame through a `mirror://` custom URI scheme, so the
// renderer can feed a `<canvas>`/`captureStream()` pipeline instead of
// polling `browser_capture` itself. Falls back to `requestMirror` returning
// `false` on platforms without real capture support (Windows/Linux — see
// `capture::platform_capture_supported`), letting the renderer keep using its
// existing `getDisplayMedia`/frame-polling fallback (see
// `renderer/hooks/useBrowserView.ts`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{http, Manager, State};

use super::capture;
use super::BrowserRegistry;

/// ~7fps: inside the spec's target 5-10fps band for mirror streaming.
const MIRROR_INTERVAL: Duration = Duration::from_millis(140);

/// Latest JPEG bytes per viewId, read by the `mirror://` protocol handler and
/// written by each view's background capture loop.
#[derive(Default)]
pub struct MirrorFrames(pub Mutex<HashMap<String, Vec<u8>>>);

/// Per-view stop flags, so `browser_destroy`/a repeated `requestMirror` call
/// can signal a running loop to exit rather than leaking threads.
#[derive(Default)]
pub struct MirrorLoops(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

impl MirrorLoops {
    /// Signals any running loop for `view_id` to stop and forgets it. Safe to
    /// call whether or not a loop is currently running.
    pub fn stop(&self, view_id: &str) {
        if let Some(flag) = self.0.lock().unwrap().remove(view_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

// NOT `async fn` — see the note on the nav.rs/capture::browser_capture
// commands: this spawns a background thread and returns immediately, but the
// initial "is this view known / is capture supported" check is cheap and
// synchronous, so it stays on Tauri's blocking thread pool like its siblings
// rather than the async IPC executor.
#[tauri::command]
pub fn browser_request_mirror(
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    loops: State<'_, MirrorLoops>,
    view_id: String,
) -> bool {
    if !capture::platform_capture_supported() {
        return false;
    }
    if !state.0.lock().unwrap().contains_key(&view_id) {
        return false;
    }
    if loops.0.lock().unwrap().contains_key(&view_id) {
        // Already mirroring this view.
        return true;
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    loops
        .0
        .lock()
        .unwrap()
        .insert(view_id.clone(), stop_flag.clone());

    // `AppHandle` is cheaply cloneable and re-exposes the same managed state
    // (`app.state::<T>()`) from any thread, so the loop re-fetches
    // `BrowserRegistry`/`MirrorFrames`/`MirrorLoops` through it each
    // iteration rather than trying to clone the `Mutex`es directly.
    let app_for_loop = app.clone();
    let view_id_for_loop = view_id.clone();

    thread::spawn(move || {
        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            let still_registered = app_for_loop
                .state::<BrowserRegistry>()
                .0
                .lock()
                .unwrap()
                .contains_key(&view_id_for_loop);
            if !still_registered {
                break;
            }
            let Some(webview) = app_for_loop.get_webview(&view_id_for_loop) else {
                break;
            };
            if let Ok(bytes) = capture::snapshot_jpeg_blocking(&webview) {
                app_for_loop
                    .state::<MirrorFrames>()
                    .0
                    .lock()
                    .unwrap()
                    .insert(view_id_for_loop.clone(), bytes);
            }
            thread::sleep(MIRROR_INTERVAL);
        }
        app_for_loop
            .state::<MirrorFrames>()
            .0
            .lock()
            .unwrap()
            .remove(&view_id_for_loop);
        app_for_loop
            .state::<MirrorLoops>()
            .0
            .lock()
            .unwrap()
            .remove(&view_id_for_loop);
    });

    true
}

/// The only renderer origins the `mirror://` response's
/// `Access-Control-Allow-Origin` is ever restricted to — the main window's
/// own origin under Tauri's asset protocol. Never widened to `*`: a `mirror`
/// response readable cross-origin would taint the renderer's mirror
/// `<canvas>`, breaking `canvas.captureStream()` with a `SecurityError` (see
/// tasks/specs/T9b-browser-panel-fixes.md fix 3c) and, if it ever were `*`,
/// would let ANY origin (including a hostile `browser-*` panel) read another
/// session's captured frames.
const ALLOWED_MIRROR_ORIGINS: &[&str] = &["tauri://localhost", "http://tauri.localhost"];

/// The single origin `Access-Control-Allow-Origin` is set to on every mirror
/// response — the main window's own asset-protocol origin (`tauri://` on
/// macOS/Linux, `http://tauri.localhost` on Windows, where custom schemes
/// can't be used as an origin). Fixed, never echoed from the request, so a
/// caller cannot widen it by spoofing an `Origin` header.
fn mirror_response_origin() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

/// True unless the request carries an `Origin` header that is present but
/// NOT one of `ALLOWED_MIRROR_ORIGINS`. A same-scheme/non-CORS request (e.g.
/// a plain `<img src="mirror://...">` without `crossOrigin` set) carries no
/// `Origin` header at all and is allowed through here — the main-window-only
/// (`ctx.webview_label() == "main"`) check above is what actually gates the
/// caller in that case; this is additional defense-in-depth against a
/// cross-origin caller that DOES send an (untrusted) `Origin` header.
fn origin_is_allowed(request: &http::Request<Vec<u8>>) -> bool {
    match request
        .headers()
        .get(http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        Some(origin) => ALLOWED_MIRROR_ORIGINS.contains(&origin),
        None => true,
    }
}

fn forbidden() -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(http::StatusCode::FORBIDDEN)
        .body(Vec::new())
        .unwrap()
}

/// `mirror://<viewId>/frame` protocol handler, registered on the `Builder` in
/// lib.rs via `register_uri_scheme_protocol("mirror", mirror::protocol_handler)`.
/// Serves the most recently captured JPEG for the viewId in the request host,
/// or a 404 if no frame has been captured yet.
///
/// SECURITY (tasks/specs/T9b-browser-panel-fixes.md fix 3): previously this
/// served ANY viewId's frame to ANY caller — a hostile `browser-*` panel
/// could read another session's captured frames just by loading
/// `mirror://<other-view-id>/frame` itself (custom URI schemes are not
/// covered by `capabilities/*.json`'s command ACL). This now:
///   (a) validates `view_id` is a well-formed `browser-<sessionId>` label
///       (`is_browser_label`) before ever looking it up;
///   (b) only serves the frame when the REQUESTING webview is the main
///       window (`ctx.webview_label() == "main"`) — a `browser-*` webview
///       requesting `mirror://` (e.g. via a hostile `<img>`/`fetch`) gets a
///       403, regardless of which viewId it asks for;
///   (c) restricts `Access-Control-Allow-Origin` to the renderer's own
///       origins, so the response is never readable cross-origin (which
///       would otherwise taint the mirror `<canvas>` and break
///       `captureStream()` with a `SecurityError` — see fix 4).
pub fn protocol_handler(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    if ctx.webview_label() != "main" {
        return forbidden();
    }
    let view_id = request.uri().host().unwrap_or_default().to_string();
    if !super::is_browser_label(&view_id) {
        return forbidden();
    }
    if !origin_is_allowed(&request) {
        return forbidden();
    }
    let allowed_origin = mirror_response_origin();

    let frames = ctx.app_handle().state::<MirrorFrames>();
    let bytes = frames.0.lock().unwrap().get(&view_id).cloned();
    match bytes {
        Some(bytes) => http::Response::builder()
            .status(http::StatusCode::OK)
            .header(http::header::CONTENT_TYPE, "image/jpeg")
            .header(http::header::CACHE_CONTROL, "no-store")
            .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, allowed_origin)
            .body(bytes)
            .unwrap(),
        None => http::Response::builder()
            .status(http::StatusCode::NOT_FOUND)
            .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, allowed_origin)
            .body(Vec::new())
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_loops_stop_is_a_no_op_for_an_unknown_view() {
        let loops = MirrorLoops::default();
        loops.stop("browser-unknown");
        assert!(loops.0.lock().unwrap().is_empty());
    }

    #[test]
    fn mirror_loops_stop_signals_and_forgets_a_registered_flag() {
        let loops = MirrorLoops::default();
        let flag = Arc::new(AtomicBool::new(false));
        loops
            .0
            .lock()
            .unwrap()
            .insert("browser-a".to_string(), flag.clone());
        loops.stop("browser-a");
        assert!(flag.load(Ordering::SeqCst));
        assert!(!loops.0.lock().unwrap().contains_key("browser-a"));
    }

    fn request_with_origin(origin: Option<&str>) -> http::Request<Vec<u8>> {
        let mut builder = http::Request::builder().uri("mirror://browser-abc/frame");
        if let Some(origin) = origin {
            builder = builder.header(http::header::ORIGIN, origin);
        }
        builder.body(Vec::new()).unwrap()
    }

    #[test]
    fn origin_is_allowed_permits_requests_with_no_origin_header() {
        assert!(origin_is_allowed(&request_with_origin(None)));
    }

    #[test]
    fn origin_is_allowed_permits_the_renderer_asset_protocol_origins() {
        assert!(origin_is_allowed(&request_with_origin(Some(
            "tauri://localhost"
        ))));
        assert!(origin_is_allowed(&request_with_origin(Some(
            "http://tauri.localhost"
        ))));
    }

    #[test]
    fn origin_is_allowed_rejects_any_other_origin() {
        assert!(!origin_is_allowed(&request_with_origin(Some(
            "https://evil.example"
        ))));
        assert!(!origin_is_allowed(&request_with_origin(Some(
            "http://localhost:5173"
        ))));
    }

    #[test]
    fn mirror_response_origin_is_one_of_the_allow_listed_origins() {
        assert!(ALLOWED_MIRROR_ORIGINS.contains(&mirror_response_origin()));
    }
}
