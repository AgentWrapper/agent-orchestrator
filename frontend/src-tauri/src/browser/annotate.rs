// Annotation mode toggling + the two commands invoked directly from inside a
// child `browser-*` webview (see `frontend/src/browser-annotate/main.ts`),
// plus shortcut forwarding. Ported from the annotation half of
// frontend/src/main/browser-view-host.ts + shared/browser-annotations.ts.
//
// `browser_annotation_submit`/`browser_annotation_cancel`/
// `browser_forward_shortcut` are the ONLY three commands the
// `browser-panel` capability allow-lists for `browser-*` webviews (see
// capabilities/browser-panel.json + build.rs's `AppManifest`) — every other
// command (including `browser_annotation_set_mode`, which the MAIN window
// calls, never a child webview) stays unreachable from hostile page content.
//
// SECURITY (accepted residual risk, tasks/specs/T9b-browser-panel-fixes.md
// fix 8): the annotate bundle's `initialization_script` runs in the loaded
// page's own MAIN WORLD (Tauri has no equivalent of Electron's isolated
// `contextBridge` preload world), so a remote/hostile page can, in principle,
// invoke the exact same 3 commands this module exposes for ITS OWN viewId.
// This is accepted, not fixed, because the blast radius is bounded by three
// independent mitigations that all have to hold simultaneously for it to
// matter:
//   1. Label validation (`validate_caller` above) — a page can only act as
//      its own viewId; it cannot spoof another session's annotation submit/
//      cancel or shortcut-forward.
//   2. Capability scoping (`capabilities/browser-panel.json` +
//      `AppManifest::commands` in build.rs) — only these 3 commands are
//      reachable at all from a `browser-*` webview; every other command
//      (daemon, settings, terminal, browser_navigate, …) is unreachable
//      regardless of what the page's JS does.
//   3. Modifier-gated shortcut forwarding (`browser-annotate/main.ts`) — only
//      chorded keydowns (ctrl/meta or the Backquote annotate-toggle pattern)
//      are ever forwarded, so a hostile page cannot use this path to log
//      plain keystrokes/text typed into itself.
// A hostile page can therefore, at worst, submit/cancel an annotation or
// forward a shortcut chord AS ITSELF — it cannot reach any other command,
// impersonate another view, or exfiltrate arbitrary keystrokes.

use tauri::{Emitter, Manager, State};

use super::{
    BrowserAnnotationCancelPayload, BrowserAnnotationModeInput, BrowserAnnotationPageCancelPayload,
    BrowserAnnotationPageSubmitPayload, BrowserAnnotationSubmitPayload, BrowserRegistry,
};

/// Rust-side half of the caller-identity check described in
/// tasks/specs/T9-browser-panel.md step 6: the invoking webview's own Tauri
/// label must equal the viewId the page-context payload claims to be. A
/// hostile/compromised page could otherwise spoof another session's viewId.
pub fn validate_caller<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    claimed_view_id: &str,
) -> Result<(), String> {
    if !crate::browser::is_browser_label(webview.label()) {
        return Err(
            "browser annotation commands may only be invoked from browser panel webviews"
                .to_string(),
        );
    }
    if webview.label() == claimed_view_id {
        Ok(())
    } else {
        Err("browser annotation payload viewId does not match the calling webview".to_string())
    }
}

/// Called by the MAIN window (never by a child webview — not in the
/// `browser-panel` capability allow-list) to toggle picker mode. Uses
/// `webview.eval()` to invoke the annotate bundle's exposed
/// `__AO_SET_ANNOTATION_MODE__`, Tauri's equivalent of Electron's
/// `contents.send("browser:annotation:setMode", ...)`.
#[tauri::command]
pub fn browser_annotation_set_mode(
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    input: BrowserAnnotationModeInput,
) {
    {
        let mut registry = state.0.lock().unwrap();
        registry
            .entry(input.view_id.clone())
            .or_default()
            .annotation_enabled = input.enabled;
    }
    if let Some(webview) = app.get_webview(&input.view_id) {
        let _ = webview.eval(format!(
            "window.__AO_SET_ANNOTATION_MODE__ && window.__AO_SET_ANNOTATION_MODE__({})",
            input.enabled
        ));
    }
}

#[tauri::command]
pub fn browser_annotation_submit(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    payload: BrowserAnnotationPageSubmitPayload,
) -> Result<(), String> {
    validate_caller(&webview, &payload.view_id)?;
    {
        let mut registry = state.0.lock().unwrap();
        registry
            .entry(payload.view_id.clone())
            .or_default()
            .annotation_enabled = false;
    }
    let forwarded = BrowserAnnotationSubmitPayload {
        view_id: payload.view_id,
        instruction: payload.instruction,
        context: payload.context,
    };
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("browser://annotation-submitted", &forwarded);
    }
    Ok(())
}

#[tauri::command]
pub fn browser_annotation_cancel(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: State<'_, BrowserRegistry>,
    payload: BrowserAnnotationPageCancelPayload,
) -> Result<(), String> {
    validate_caller(&webview, &payload.view_id)?;
    {
        let mut registry = state.0.lock().unwrap();
        registry
            .entry(payload.view_id.clone())
            .or_default()
            .annotation_enabled = false;
    }
    let forwarded = BrowserAnnotationCancelPayload {
        view_id: payload.view_id,
        reason: payload.reason,
    };
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("browser://annotation-canceled", &forwarded);
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedShortcutChord {
    pub view_id: String,
    pub key: String,
    pub code: String,
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
    pub alt: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardedShortcutPayload {
    key: String,
    code: String,
    ctrl: bool,
    meta: bool,
    shift: bool,
    alt: bool,
}

/// Re-emits a keydown chord captured inside a child webview to the main
/// window as `browser://forward-shortcut`; the renderer's shortcut engine
/// (`renderer/lib/shortcut-engine.ts`) does the actual chord-to-channel
/// matching there — Rust is a dumb relay, so the matching table never has to
/// be duplicated into the annotate bundle. Validates caller identity the
/// same way the annotation commands do.
#[tauri::command]
pub fn browser_forward_shortcut(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    chord: ForwardedShortcutChord,
) -> Result<(), String> {
    validate_caller(&webview, &chord.view_id)?;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(
            "browser://forward-shortcut",
            &ForwardedShortcutPayload {
                key: chord.key,
                code: chord.code,
                ctrl: chord.ctrl,
                meta: chord.meta,
                shift: chord.shift,
                alt: chord.alt,
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_registry() -> BrowserRegistry {
        BrowserRegistry::default()
    }

    /// Builds a real (mock-runtime) `tauri::WebviewWindow` labeled `label`,
    /// via `tauri::test::mock_builder` (dev-dependency `tauri` feature
    /// `"test"` — see Cargo.toml), so the tests below exercise
    /// `validate_caller` itself rather than re-asserting a string literal.
    fn mock_webview_labeled(label: &str) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock tauri app");
        tauri::WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .expect("failed to build mock webview window")
    }

    #[test]
    fn validate_caller_accepts_a_matching_label_and_view_id() {
        let webview_window = mock_webview_labeled("browser-abc");
        assert!(validate_caller(webview_window.as_ref(), "browser-abc").is_ok());
        let _ = make_registry();
    }

    #[test]
    fn validate_caller_rejects_a_mismatched_view_id() {
        let webview_window = mock_webview_labeled("browser-abc");
        let result = validate_caller(webview_window.as_ref(), "browser-xyz");
        assert!(result.is_err());
    }

    #[test]
    fn validate_caller_rejects_a_non_browser_label_caller() {
        let webview_window = mock_webview_labeled("main");
        assert!(!super::super::is_browser_label(webview_window.label()));
        let result = validate_caller(webview_window.as_ref(), "browser-abc");
        assert!(result.is_err());
    }
}
