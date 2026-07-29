mod daemon;
mod import_scan;
mod misc;
mod paths;
mod settings;
mod shell_env;
#[cfg(target_os = "macos")]
pub mod browser_spike;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(daemon::DaemonState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .setup(|app| {
            misc::init(&app.handle().clone());
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
            #[cfg(target_os = "macos")]
            browser_spike::browser_capture_spike,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
