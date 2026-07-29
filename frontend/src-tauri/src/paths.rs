use std::path::PathBuf;

/// Returns the app's data directory: `$AO_DATA_DIR` if set, otherwise `~/.ao`.
pub fn ao_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AO_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::home_dir()
        .expect("could not resolve home directory")
        .join(".ao")
}

/// Directory used for the Tauri webview's persisted data (cache, cookies,
/// local/session storage, etc.), nested under the app data dir.
pub fn webview_data_dir() -> PathBuf {
    ao_data_dir().join("tauri")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serializes tests that mutate process-wide env vars.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn ao_data_dir_uses_env_override_when_set() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("AO_DATA_DIR", "/tmp/ao-test-data-dir");
        assert_eq!(ao_data_dir(), PathBuf::from("/tmp/ao-test-data-dir"));
        std::env::remove_var("AO_DATA_DIR");
    }

    #[test]
    fn ao_data_dir_falls_back_to_home_dot_ao() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("AO_DATA_DIR");
        let expected = dirs::home_dir().unwrap().join(".ao");
        assert_eq!(ao_data_dir(), expected);
    }

    #[test]
    fn webview_data_dir_is_nested_under_ao_data_dir() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("AO_DATA_DIR", "/tmp/ao-test-data-dir");
        assert_eq!(
            webview_data_dir(),
            PathBuf::from("/tmp/ao-test-data-dir/tauri")
        );
        std::env::remove_var("AO_DATA_DIR");
    }
}
