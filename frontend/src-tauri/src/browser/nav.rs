// Navigation hardening + back/forward/stop/reload commands. URL
// normalization and the omnibox heuristics (`normalizeBrowserURL`,
// `withDefaultScheme`, ...) stay in TS — see
// `frontend/src/renderer/lib/browser-url.ts` (ported from
// frontend/src/main/browser-view-host.ts) — this module only re-validates
// the protocol allowlist as defense-in-depth, mirroring Electron's
// `will-navigate`/`will-redirect`/`setWindowOpenHandler` hardening, which
// runs independently of the renderer's own normalization.

use tauri::{Manager, State};

use super::{host, BrowserNavigateInput, BrowserRegistry};

/// Ported from `ALLOWED_PROTOCOLS` in browser-view-host.ts.
const ALLOWED_PROTOCOLS: &[&str] = &["http:", "https:", "file:"];

pub fn is_allowed_protocol(url: &tauri::Url) -> bool {
    let scheme_with_colon = format!("{}:", url.scheme());
    ALLOWED_PROTOCOLS.contains(&scheme_with_colon.as_str())
}

/// Builds the `on_navigation` handler installed on every child webview: it
/// blocks navigations whose scheme is not in the allowlist, the same
/// hardening Electron applies via `will-navigate`/`will-redirect`.
pub fn allowlist_navigation_handler(app: tauri::AppHandle, view_id: String) -> impl Fn(&tauri::Url) -> bool {
    move |url: &tauri::Url| {
        if is_allowed_protocol(url) {
            return true;
        }
        host::mark_error(&app, &view_id, "Unsupported browser URL".to_string());
        false
    }
}

// Every command below MUST be `#[tauri::command(async)]`
// (tasks/specs/T9b-browser-panel-fixes.md fix 2, and the concurrency
// contract in `browser/mod.rs`'s module doc): each one ends by calling
// `host::push_nav_state`, which calls `capture::history_state_blocking` —
// itself a `recv_timeout` wait for a completion only the main run loop can
// deliver. A plain (non-`async`) `#[tauri::command]` runs INLINE on whatever
// thread delivered the IPC message (the main/webview thread), so calling
// that chain from one would self-deadlock the exact same way
// `browser_capture` did (see `capture/mod.rs`). Marking these `async`
// dispatches them onto Tauri's async runtime instead, off the main thread.
#[tauri::command(async)]
pub fn browser_navigate(
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    input: BrowserNavigateInput,
) -> Result<super::BrowserNavState, String> {
    if !state.0.lock().unwrap().contains_key(&input.view_id) {
        host::ensure_entry(&state, &input.view_id);
    }
    let url = tauri::Url::parse(&input.url).map_err(|e| e.to_string())?;
    if !is_allowed_protocol(&url) {
        return Err("Unsupported browser URL".to_string());
    }
    let webview = app.get_webview(&input.view_id).ok_or("browser view not found")?;
    webview.navigate(url).map_err(|e| e.to_string())?;
    Ok(host::push_nav_state(&app, &state, &input.view_id))
}

#[tauri::command(async)]
pub fn browser_clear(
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    view_id: String,
) -> Result<super::BrowserNavState, String> {
    host::ensure_entry(&state, &view_id);
    if let Some(webview) = app.get_webview(&view_id) {
        let _ = webview.hide();
        let _ = webview.navigate(tauri::Url::parse("about:blank").unwrap());
    }
    Ok(host::push_nav_state(&app, &state, &view_id))
}

fn invoke_nav<F: FnOnce(&tauri::Webview)>(app: &tauri::AppHandle, view_id: &str, action: F) {
    if let Some(webview) = app.get_webview(view_id) {
        action(&webview);
    }
}

#[tauri::command(async)]
pub fn browser_go_back(
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    view_id: String,
) -> Result<super::BrowserNavState, String> {
    invoke_nav(&app, &view_id, super::capture::go_back);
    Ok(host::push_nav_state(&app, &state, &view_id))
}

#[tauri::command(async)]
pub fn browser_go_forward(
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    view_id: String,
) -> Result<super::BrowserNavState, String> {
    invoke_nav(&app, &view_id, super::capture::go_forward);
    Ok(host::push_nav_state(&app, &state, &view_id))
}

#[tauri::command(async)]
pub fn browser_reload(
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    view_id: String,
) -> Result<super::BrowserNavState, String> {
    invoke_nav(&app, &view_id, |webview| {
        let _ = webview.reload();
    });
    Ok(host::push_nav_state(&app, &state, &view_id))
}

#[tauri::command(async)]
pub fn browser_stop(
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    view_id: String,
) -> Result<super::BrowserNavState, String> {
    invoke_nav(&app, &view_id, super::capture::stop_loading);
    Ok(host::push_nav_state(&app, &state, &view_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        tauri::Url::parse(s).unwrap()
    }

    #[test]
    fn allows_http_https_and_file_schemes() {
        assert!(is_allowed_protocol(&url("http://example.com")));
        assert!(is_allowed_protocol(&url("https://example.com")));
        assert!(is_allowed_protocol(&url("file:///tmp/x.html")));
    }

    #[test]
    fn rejects_everything_else() {
        assert!(!is_allowed_protocol(&url("javascript:alert(1)")));
        assert!(!is_allowed_protocol(&url("chrome://settings")));
        assert!(!is_allowed_protocol(&url("data:text/html,hi")));
    }
}
