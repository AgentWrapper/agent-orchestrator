// T9 spike gate: prove that a Tauri child webview on macOS can be
// snapshotted through WKWebView.takeSnapshotWithConfiguration and turned
// into JPEG bytes, before building the full browser-panel feature (see
// tasks/specs/T9-browser-panel.md step 1). Run with:
//   cargo run --example browser_spike
#[cfg(target_os = "macos")]
fn main() {
    use agent_orchestrator_desktop_lib::browser_spike::browser_capture_spike;
    use tauri::Manager;

    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let window = app.get_window("main").expect("main window");
            let _ = window.show();
            let _ = window.set_focus();
            std::thread::spawn(move || {
                // Let the main window finish constructing before we attach a
                // child webview to it.
                std::thread::sleep(std::time::Duration::from_millis(500));
                let result = browser_capture_spike(window);
                match result {
                    Ok(value) => {
                        println!("SPIKE_RESULT {}", value);
                    }
                    Err(err) => {
                        eprintln!("SPIKE_ERROR {}", err);
                    }
                }
                handle.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("browser_spike example is macOS-only");
}
