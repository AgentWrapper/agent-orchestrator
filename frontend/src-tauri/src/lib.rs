mod browser;
mod command_names;
mod daemon;
mod import_scan;
mod misc;
mod paths;
mod settings;
mod shell_env;
mod updater;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Hard rule: all app state lives under ~/.ao. Ensure the webview profile
    // dir exists and, on Windows, pin WebView2's user data folder to it
    // before any webview is created.
    let webview_dir = paths::webview_data_dir();
    let _ = std::fs::create_dir_all(&webview_dir);
    #[cfg(target_os = "windows")]
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_dir);

    tauri::Builder::default()
        .manage(daemon::DaemonState::default())
        .manage(browser::BrowserRegistry::default())
        .manage(browser::mirror::MirrorFrames::default())
        .manage(browser::mirror::MirrorLoops::default())
        .manage(updater::UpdaterState::default())
        .manage(updater::PendingInstall::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        // Serves the latest captured frame for a mirrored browser panel at
        // `mirror://<viewId>/frame` (see browser/mirror.rs) — the renderer's
        // `useBrowserView` mirror consumer feeds this into a
        // `canvas.captureStream()` pipeline when `browser.requestMirror`
        // resolves true.
        .register_uri_scheme_protocol("mirror", browser::mirror::protocol_handler)
        .setup(|app| {
            misc::init(&app.handle().clone());
            daemon::start_on_boot(app.handle());
            updater::start_automatic_check_timer(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon::daemon_get_status,
            daemon::daemon_start,
            daemon::daemon_stop,
            daemon::daemon_restart,
            settings::keybindings_get,
            settings::keybindings_set,
            settings::keybindings_set_recording,
            settings::app_state_get_migration,
            settings::app_state_set_migration,
            settings::update_settings_get,
            settings::update_settings_set,
            settings::update_settings_has_decision,
            misc::app_scan_import_folder,
            misc::terminal_save_dropped_file,
            misc::telemetry_get_bootstrap,
            misc::theme_set,
            misc::window_set_overlay,
            misc::window_is_full_screen,
            misc::menu_action,
            misc::notifications_show,
            misc::clipboard_write_primary,
            misc::app_get_version,
            browser::host::browser_ensure,
            browser::bounds::browser_set_bounds,
            browser::nav::browser_navigate,
            browser::nav::browser_clear,
            browser::capture::browser_capture,
            browser::mirror::browser_request_mirror,
            browser::nav::browser_go_back,
            browser::nav::browser_go_forward,
            browser::nav::browser_reload,
            browser::nav::browser_stop,
            browser::host::browser_destroy,
            browser::annotate::browser_annotation_set_mode,
            browser::annotate::browser_annotation_submit,
            browser::annotate::browser_annotation_cancel,
            browser::annotate::browser_forward_shortcut,
            updater::updates_get_status,
            updater::updates_check,
            updater::updates_return_home,
            updater::updates_download,
            updater::updates_install,
            updater::feature_builds_list,
            updater::feature_builds_get_active,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod acl_coverage_tests {
    use crate::command_names::{ALL_COMMAND_NAMES, BROWSER_PANEL_COMMAND_NAMES};

    fn permission_slug(command: &str) -> String {
        format!("allow-{}", command.replace('_', "-"))
    }

    /// Deliberately duplicates the `generate_handler!` command list above
    /// (rather than introspecting it at runtime — Tauri doesn't expose that)
    /// so that adding/removing a command from the invoke handler without
    /// updating `command_names::ALL_COMMAND_NAMES` (and therefore
    /// `build.rs`'s `AppManifest`) fails this test. See fix 1 in
    /// tasks/specs/T9b-browser-panel-fixes.md.
    #[test]
    fn all_command_names_matches_the_invoke_handler_list() {
        let invoke_handler_commands: &[&str] = &[
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
        assert_eq!(ALL_COMMAND_NAMES, invoke_handler_commands);
    }

    /// Parses the autogenerated `gen/schemas/capabilities.json` (produced by
    /// `build.rs`/`tauri_build::try_build` from `capabilities/*.json` + the
    /// `AppManifest`) and asserts:
    ///   - `main-window` is granted an `allow-<command>` permission for
    ///     EVERY command in the invoke handler (regression test for the
    ///     app-breaking ACL brick in fix 1: previously only 3 commands were
    ///     declared to `AppManifest`, so no other command had an
    ///     autogenerated permission to grant at all, and every app IPC call
    ///     was silently rejected at runtime).
    ///   - `browser-panel` (the untrusted child-webview capability) is
    ///     granted EXACTLY the 3 forwarding commands and nothing else.
    #[test]
    fn gen_schemas_capabilities_grants_every_command_to_main_window_and_exactly_three_to_browser_panel(
    ) {
        let manifest = include_str!("../gen/schemas/capabilities.json");
        let capabilities: serde_json::Value = serde_json::from_str(manifest)
            .expect("gen/schemas/capabilities.json must be valid JSON after `cargo build`");

        let main_permissions: Vec<&str> = capabilities["main-window"]["permissions"]
            .as_array()
            .expect("main-window capability missing from gen/schemas/capabilities.json — run `cargo build` first")
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        for command in ALL_COMMAND_NAMES {
            let slug = permission_slug(command);
            assert!(
                main_permissions.contains(&slug.as_str()),
                "main-window capability is missing `{slug}` (command `{command}`) — every app command must be reachable from the main window"
            );
        }

        let mut browser_panel_permissions: Vec<&str> = capabilities["browser-panel"]["permissions"]
            .as_array()
            .expect("browser-panel capability missing from gen/schemas/capabilities.json — run `cargo build` first")
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        browser_panel_permissions.sort_unstable();

        let mut expected: Vec<String> = BROWSER_PANEL_COMMAND_NAMES
            .iter()
            .map(|c| permission_slug(c))
            .collect();
        expected.sort();
        let expected: Vec<&str> = expected.iter().map(|s| s.as_str()).collect();

        assert_eq!(browser_panel_permissions, expected);
    }
}
