// T9 (M4) — embedded multi-webview browser panel.
//
// Ported from (semantics only):
//   - frontend/src/main/browser-view-host.ts (+ .test.ts)
//   - frontend/src/annotate-preload.ts (rebuilt as plain JS, see
//     `frontend/src/browser-annotate/main.ts`)
//   - frontend/src/shared/browser-annotations.ts
//
// Concurrency contract (load-bearing, proven by the spike in
// `git show a7b23fbdf:frontend/src-tauri/src/browser_spike.rs` — now deleted,
// ported into `capture/macos.rs`): any native async webview API
// (`takeSnapshot`/`CapturePreview`/`snapshot`) is INITIATED on the main
// thread (`with_webview`) and its completion handler is delivered on the main
// run loop — callers must never block the main thread waiting for the
// result. Initiate on main, receive bytes on a background thread/task. See
// `capture::macos::snapshot_jpeg_blocking`.
//
// CORRECTION (tasks/specs/T9b-browser-panel-fixes.md fix 2): a plain
// (non-`async`-attributed) `#[tauri::command]` is NOT dispatched onto a
// background/blocking thread pool by Tauri — it runs INLINE on whatever
// thread delivered the IPC message, which is the main/webview thread. Only
// `#[tauri::command(async)]` (or an `async fn` command) is dispatched onto
// Tauri's async runtime, off that thread. Every command in this module tree
// that (transitively) calls a `*_blocking` helper — `browser_capture`,
// `browser_navigate`, `browser_clear`, `browser_go_back`,
// `browser_go_forward`, `browser_reload`, `browser_stop`, `browser_ensure` —
// MUST be `async`, or its `recv_timeout` wait for a main-run-loop completion
// self-deadlocks for up to the timeout before returning an empty/failed
// result.

pub mod annotate;
pub mod bounds;
pub mod capture;
pub mod host;
pub mod mirror;
pub mod nav;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

pub use host::BrowserEntry;

/// Byte-matches `BrowserRect` in frontend/src/shared/bridge-types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BrowserRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Byte-matches `BrowserNavState` in frontend/src/shared/bridge-types.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavState {
    pub view_id: String,
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub is_loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BrowserNavState {
    pub fn empty(view_id: &str) -> Self {
        BrowserNavState {
            view_id: view_id.to_string(),
            url: String::new(),
            title: String::new(),
            can_go_back: false,
            can_go_forward: false,
            is_loading: false,
            error: None,
        }
    }
}

/// Byte-matches `BrowserBoundsInput`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBoundsInput {
    pub view_id: String,
    pub rect: BrowserRect,
    pub visible: bool,
    #[serde(default)]
    pub parked: Option<bool>,
}

/// Byte-matches `BrowserNavigateInput`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigateInput {
    pub view_id: String,
    pub url: String,
}

/// Byte-matches `BrowserAnnotationModeInput` (shared/browser-annotations.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationModeInput {
    pub view_id: String,
    pub enabled: bool,
}

/// Payload posted by the annotate-preload bundle itself (page context), which
/// — unlike Electron's per-webContents IPC sender — includes its own viewId
/// since Tauri has no equivalent of `event.sender.id` scoping; Rust validates
/// it against the invoking webview's label (see `annotate::validate_caller`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationPageSubmitPayload {
    pub view_id: String,
    pub instruction: String,
    pub context: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationPageCancelPayload {
    pub view_id: String,
    #[serde(default = "default_cancel_reason")]
    pub reason: String,
}

fn default_cancel_reason() -> String {
    "cancel".to_string()
}

/// Byte-matches `BrowserAnnotationSubmitPayload`/`BrowserAnnotationCancelPayload`
/// re-emitted to the main window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationSubmitPayload {
    pub view_id: String,
    pub instruction: String,
    pub context: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationCancelPayload {
    pub view_id: String,
    pub reason: String,
}

/// Registry of live browser panels, keyed by viewId (== the child webview's
/// Tauri label, `browser-<sessionId>`). Managed as app state.
#[derive(Default)]
pub struct BrowserRegistry(pub Mutex<HashMap<String, BrowserEntry>>);

// ---------------------------------------------------------------------------
// Label / viewId helpers.
// ---------------------------------------------------------------------------

pub const BROWSER_LABEL_PREFIX: &str = "browser-";

pub fn label_for_session(session_id: &str) -> String {
    format!("{BROWSER_LABEL_PREFIX}{session_id}")
}

/// True when `label` is a well-formed `browser-<sessionId>` viewId matching
/// the `browser-*` glob the `browser-panel` capability restricts child
/// webviews to. Used both to validate `browser_ensure` input and, in tests,
/// to assert the capability glob and the labels we mint agree.
pub fn is_browser_label(label: &str) -> bool {
    label.starts_with(BROWSER_LABEL_PREFIX) && label.len() > BROWSER_LABEL_PREFIX.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_for_session_is_prefixed_and_idempotent_input() {
        assert_eq!(label_for_session("abc123"), "browser-abc123");
        assert_eq!(label_for_session("abc123"), label_for_session("abc123"));
    }

    #[test]
    fn is_browser_label_matches_only_well_formed_labels() {
        assert!(is_browser_label("browser-abc"));
        assert!(!is_browser_label("browser-"));
        assert!(!is_browser_label("main"));
        assert!(!is_browser_label(""));
    }

    #[test]
    fn empty_nav_state_carries_the_view_id_and_no_error() {
        let state = BrowserNavState::empty("browser-abc");
        assert_eq!(state.view_id, "browser-abc");
        assert_eq!(state.url, "");
        assert!(!state.can_go_back);
        assert!(state.error.is_none());
    }

    #[test]
    fn nav_state_serializes_with_camel_case_field_names_and_omits_absent_error() {
        let state = BrowserNavState::empty("browser-abc");
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "viewId": "browser-abc",
                "url": "",
                "title": "",
                "canGoBack": false,
                "canGoForward": false,
                "isLoading": false,
            })
        );
    }

    /// Automated stand-in for the "hostile page in a child `browser-*`
    /// webview can only reach 3 commands" requirement (T9 step 10). A real
    /// invoke-time ACL check needs a running `App`, which is not
    /// constructible in a unit test, so this instead asserts the capability
    /// manifest itself grants exactly the 3 forwarding commands and nothing
    /// else, and that it actually applies to the `browser-*` webviews we
    /// mint — regressions here (a widened permission list, a typo'd glob)
    /// would silently reopen every other command to remote page content.
    #[test]
    fn browser_panel_capability_allow_lists_exactly_the_three_forwarding_commands() {
        let manifest = include_str!("../../capabilities/browser-panel.json");
        let capability: serde_json::Value = serde_json::from_str(manifest).unwrap();

        let webviews = capability["webviews"].as_array().unwrap();
        assert_eq!(webviews, &[serde_json::json!("browser-*")]);
        assert!(is_browser_label("browser-abc123"));

        let mut permissions: Vec<&str> =
            capability["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
        permissions.sort_unstable();
        assert_eq!(
            permissions,
            vec!["allow-browser-annotation-cancel", "allow-browser-annotation-submit", "allow-browser-forward-shortcut"]
        );
    }
}
