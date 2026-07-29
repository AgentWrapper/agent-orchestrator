// Single source of truth for the full set of `#[tauri::command]`s registered
// via `tauri::generate_handler!` in `lib.rs`.
//
// Included from TWO different compilation contexts:
//   - `build.rs` (via `include!`, since build scripts are compiled
//     standalone and can't `mod` into the crate's own source tree) to
//     declare `AppManifest::commands`, so Tauri autogenerates an
//     `allow-<command>` permission for every one of them.
//   - `lib.rs` (as a normal `mod`) so a test can assert this list is kept in
//     sync with the `generate_handler!` invocation, and that
//     `capabilities/main.json` actually grants all of them.
//
// See tasks/specs/T9b-browser-panel-fixes.md fix 1: previously `build.rs`
// only declared 3 commands, which flips Tauri's `has_app_acl` to `true` and
// makes it reject EVERY app command not explicitly granted — since the main
// window had zero app-command grants, this silently broke all IPC
// (daemon_*, keybindings_*, browser_*, …) at runtime.
// Only consumed by `build.rs` (compiled standalone as a crate root, where
// this file is spliced in via `include!` — an inner `#![allow]` isn't valid
// there) and by `#[cfg(test)]` code in `lib.rs`; a normal (non-test) build of
// the library crate never references these, hence the per-item `#[allow]`
// below rather than `#[cfg(test)]`-gating the whole module (which would make
// it invisible to `build.rs`'s `include!`).
#[allow(dead_code)]
pub const ALL_COMMAND_NAMES: &[&str] = &[
    "daemon_get_status",
    "daemon_start",
    "daemon_stop",
    "daemon_restart",
    "keybindings_get",
    "keybindings_set",
    "keybindings_set_recording",
    "app_state_get_migration",
    "app_state_set_migration",
    "update_settings_get",
    "update_settings_set",
    "update_settings_has_decision",
    "app_scan_import_folder",
    "terminal_save_dropped_file",
    "telemetry_get_bootstrap",
    "theme_set",
    "window_set_overlay",
    "window_is_full_screen",
    "menu_action",
    "notifications_show",
    "clipboard_write_primary",
    "app_get_version",
    "browser_ensure",
    "browser_set_bounds",
    "browser_navigate",
    "browser_clear",
    "browser_capture",
    "browser_request_mirror",
    "browser_go_back",
    "browser_go_forward",
    "browser_reload",
    "browser_stop",
    "browser_destroy",
    "browser_annotation_set_mode",
    "browser_annotation_submit",
    "browser_annotation_cancel",
    "browser_forward_shortcut",
    "updates_get_status",
    "updates_check",
    "updates_return_home",
    "updates_download",
    "updates_install",
    "feature_builds_list",
    "feature_builds_get_active",
];

/// The 3 commands invoked directly from inside an untrusted child
/// `browser-*` webview — the only ones `capabilities/browser-panel.json`
/// allow-lists. Kept alongside `ALL_COMMAND_NAMES` so tests can assert the
/// two lists (all commands vs. the browser-panel subset) don't drift apart.
#[allow(dead_code)]
pub const BROWSER_PANEL_COMMAND_NAMES: &[&str] =
    &["browser_annotation_submit", "browser_annotation_cancel", "browser_forward_shortcut"];
