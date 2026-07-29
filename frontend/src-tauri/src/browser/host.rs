// Registry + lifecycle (`browser_ensure`/`browser_destroy`), ported from the
// `ensure`/`destroy` half of frontend/src/main/browser-view-host.ts. viewId
// is the child webview's Tauri label (`browser-<sessionId>`) throughout —
// there is no separate id-to-webContents map to maintain the way Electron
// needed one, since Tauri labels are already globally unique and directly
// addressable via `Manager::get_webview`.

use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewBuilder, WebviewUrl};

use super::bounds::OFFSCREEN_X;
use super::{label_for_session, nav, BrowserNavState, BrowserRegistry};

/// Per-view bookkeeping. `title` is tracked separately from the rest of the
/// nav state because it arrives from a distinct native callback
/// (`on_document_title_changed`) than url/loading (`on_navigation`/
/// `on_page_load`).
#[derive(Debug, Clone, Default)]
pub struct BrowserEntry {
    pub url: String,
    pub title: String,
    pub is_loading: bool,
    pub error: Option<String>,
    pub annotation_enabled: bool,
}

impl BrowserEntry {
    fn nav_state(&self, view_id: &str, history: (bool, bool)) -> BrowserNavState {
        BrowserNavState {
            view_id: view_id.to_string(),
            url: self.url.clone(),
            title: self.title.clone(),
            can_go_back: history.0,
            can_go_forward: history.1,
            is_loading: self.is_loading,
            error: self.error.clone(),
        }
    }
}

/// Inserts a default entry for `view_id` if one is not already registered.
/// Defensive: commands that operate on a viewId should normally only run
/// after `browser_ensure`, but this keeps them from panicking/no-op-ing on a
/// races (e.g. a stale viewId from a torn-down session).
pub fn ensure_entry(state: &State<'_, BrowserRegistry>, view_id: &str) {
    state.0.lock().unwrap().entry(view_id.to_string()).or_default();
}

pub fn mark_error(app: &tauri::AppHandle, view_id: &str, message: String) {
    let state = app.state::<BrowserRegistry>();
    {
        let mut registry = state.0.lock().unwrap();
        let entry = registry.entry(view_id.to_string()).or_default();
        entry.error = Some(message);
        entry.is_loading = false;
    }
    push_nav_state(app, &state, view_id);
}

/// Recomputes the full `BrowserNavState` (title/url/loading from the
/// registry entry, canGoBack/canGoForward freshly queried from the native
/// webview) and emits it on `browser://nav-state`, byte-matching
/// `AoBridge["browser"]["onNavState"]`.
pub fn push_nav_state(app: &tauri::AppHandle, state: &State<'_, BrowserRegistry>, view_id: &str) -> BrowserNavState {
    let history = app
        .get_webview(view_id)
        .and_then(|webview| super::capture::history_state_blocking(&webview).ok())
        .unwrap_or((false, false));
    let next = {
        let mut registry = state.0.lock().unwrap();
        let entry = registry.entry(view_id.to_string()).or_default();
        entry.nav_state(view_id, history)
    };
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("browser://nav-state", &next);
    }
    next
}

// MUST be `#[tauri::command(async)]` (tasks/specs/T9b-browser-panel-fixes.md
// fix 2): `browser_ensure` ends by calling `push_nav_state`, which calls
// `capture::history_state_blocking` — a `recv_timeout` wait for a completion
// only the main run loop can deliver (see the concurrency contract in
// `browser/mod.rs`'s module doc). A plain (non-`async`) `#[tauri::command]`
// runs INLINE on whatever thread delivered the IPC message (the
// main/webview thread), which would self-deadlock the same way
// `browser_capture` did. This also matches tauri's own guidance
// (`WebviewWindowBuilder::new`'s docs: "this function deadlocks when used in
// a synchronous command... use `async` commands... instead") for the
// `window.add_child` call below.
#[tauri::command(async)]
pub fn browser_ensure(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, BrowserRegistry>,
    session_id: String,
) -> Result<BrowserNavState, String> {
    let view_id = label_for_session(&session_id);
    if state.0.lock().unwrap().contains_key(&view_id) {
        return Ok(push_nav_state(&app, &state, &view_id));
    }

    let annotate_init_script =
        format!("window.__AO_BROWSER_VIEW_ID__ = {};\n{}", serde_json::to_string(&view_id).unwrap(), annotate_bundle());

    let handler_app = app.clone();
    let handler_view_id = view_id.clone();
    let builder = WebviewBuilder::new(view_id.clone(), WebviewUrl::External("about:blank".parse().unwrap()))
        .initialization_script(annotate_init_script)
        .on_navigation(nav::allowlist_navigation_handler(handler_app, handler_view_id))
        .on_page_load({
            let app = app.clone();
            let view_id = view_id.clone();
            move |_webview, payload| {
                let state = app.state::<BrowserRegistry>();
                let is_started = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
                {
                    let mut registry = state.0.lock().unwrap();
                    let entry = registry.entry(view_id.clone()).or_default();
                    entry.is_loading = is_started;
                    let url = payload.url().to_string();
                    entry.url = if url == "about:blank" { String::new() } else { url };
                    if is_started {
                        entry.error = None;
                    }
                }
                push_nav_state(&app, &state, &view_id);
            }
        })
        .on_document_title_changed({
            let app = app.clone();
            let view_id = view_id.clone();
            move |_webview, title| {
                let state = app.state::<BrowserRegistry>();
                {
                    let mut registry = state.0.lock().unwrap();
                    registry.entry(view_id.clone()).or_default().title = title;
                }
                push_nav_state(&app, &state, &view_id);
            }
        });

    let child = window
        .add_child(builder, LogicalPosition::new(OFFSCREEN_X, 0.0), LogicalSize::new(1.0, 1.0))
        .map_err(|e| e.to_string())?;
    let _ = child.hide();

    state.0.lock().unwrap().insert(view_id.clone(), BrowserEntry::default());
    Ok(push_nav_state(&app, &state, &view_id))
}

#[tauri::command]
pub fn browser_destroy(app: tauri::AppHandle, state: State<'_, BrowserRegistry>, view_id: String) {
    state.0.lock().unwrap().remove(&view_id);
    app.state::<super::mirror::MirrorLoops>().stop(&view_id);
    if let Some(webview) = app.get_webview(&view_id) {
        let _ = webview.hide();
        let _ = webview.close();
    }
}

/// Compiled `frontend/src/browser-annotate/main.ts` IIFE bundle — see
/// `frontend/src/browser-annotate/README.md` (build step) for how
/// `annotate-bundle.js` is produced. `include_str!` embeds it at compile
/// time so no extra runtime file access is needed.
fn annotate_bundle() -> &'static str {
    include_str!("annotate-bundle.js")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_entry_is_idempotent_and_defaults_to_empty_state() {
        let registry = BrowserRegistry::default();
        {
            let s: std::sync::MutexGuard<_> = registry.0.lock().unwrap();
            assert!(s.is_empty());
        }
        registry.0.lock().unwrap().entry("browser-a".to_string()).or_default();
        registry.0.lock().unwrap().entry("browser-a".to_string()).or_default();
        assert_eq!(registry.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn nav_state_reflects_entry_fields_and_freshly_queried_history() {
        let entry = BrowserEntry {
            url: "https://example.com/".to_string(),
            title: "Example".to_string(),
            is_loading: true,
            error: None,
            annotation_enabled: false,
        };
        let state = entry.nav_state("browser-a", (true, false));
        assert_eq!(state.view_id, "browser-a");
        assert_eq!(state.url, "https://example.com/");
        assert_eq!(state.title, "Example");
        assert!(state.can_go_back);
        assert!(!state.can_go_forward);
        assert!(state.is_loading);
    }

    #[test]
    fn nav_state_carries_forward_a_set_error() {
        let entry = BrowserEntry { error: Some("Unsupported browser URL".to_string()), ..Default::default() };
        let state = entry.nav_state("browser-a", (false, false));
        assert_eq!(state.error.as_deref(), Some("Unsupported browser URL"));
    }
}
