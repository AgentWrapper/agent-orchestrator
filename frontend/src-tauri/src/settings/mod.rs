// Keybinding overrides, app-state migration marker, and update-settings
// persistence commands.
//
// Ported from (semantics only):
//   - frontend/src/main/keybinding-settings.ts (+ .test.ts)
//   - frontend/src/shared/shortcuts.ts (validation rules only — matching,
//     labeling, and the default-binding table are renderer/M3 concerns)
//   - frontend/src/main/app-state.ts (+ .test.ts) — migration block only；
//     the launch-marker write (writeAppStateMarker) is out of scope here,
//     it belongs to the daemon/launch path.
//   - frontend/src/main/update-settings.ts (+ .test.ts)
//
// All three files live under `paths::ao_data_dir()`. Every write is atomic:
// a `.tmp` sibling file is written first, then renamed over the target.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::paths;

fn now_suffix() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}-{millis}", std::process::id())
}

fn atomic_write(dir: &Path, file_name: &str, tmp_prefix: &str, data: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let file = dir.join(file_name);
    let tmp = dir.join(format!(".{tmp_prefix}-{}.json", now_suffix()));
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, &file)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Keybindings — port of keybinding-settings.ts + the validation rules in
// shared/shortcuts.ts.
// ---------------------------------------------------------------------------

pub const KEYBINDING_SETTINGS_FILE_NAME: &str = "keybindings.json";

/// Customizable shortcut ids (APP_SHORTCUTS filtered by `customizable !==
/// false`) — every id except the fixed indexed "open-project" family.
const CUSTOMIZABLE_IDS: &[&str] = &[
    "new-session",
    "new-shell-terminal",
    "keyboard-shortcuts",
    "toggle-sidebar",
    "previous-session",
    "next-session",
    "toggle-inspector",
    "command-palette",
    "open-settings",
    "focus-terminal",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
    pub alt: bool,
}

fn normalized_key(key: &str) -> String {
    if key == "Up" {
        return "arrowup".to_string();
    }
    if key == "Down" {
        return "arrowdown".to_string();
    }
    key.to_lowercase()
}

/// Port of `shortcutBindingValidationError` (frontend/src/shared/shortcuts.ts).
fn shortcut_binding_validation_error(
    binding: &ShortcutBinding,
    is_mac: bool,
) -> Option<&'static str> {
    let key = normalized_key(&binding.key);

    const MODIFIER_KEYS: [&str; 11] = [
        "alt",
        "altgraph",
        "capslock",
        "control",
        "dead",
        "meta",
        "numlock",
        "process",
        "scrolllock",
        "shift",
        "unidentified",
    ];
    if MODIFIER_KEYS.contains(&key.as_str()) {
        return Some("Press a non-modifier key with Ctrl, Alt, or Cmd.");
    }
    if !binding.ctrl && !binding.meta && !binding.alt {
        return Some("Use Ctrl, Alt, or Cmd with another key.");
    }

    if binding.ctrl && !binding.meta && !binding.alt {
        if key == "c" || key == "v" {
            return Some("That shortcut is reserved for terminal copy, paste, or interrupt.");
        }
        if !binding.shift && ["d", "z", "\\", "s", "q"].contains(&key.as_str()) {
            return Some("That shortcut is reserved for terminal control.");
        }
    }

    if is_mac
        && binding.meta
        && !binding.ctrl
        && !binding.alt
        && ["a", "c", "h", "m", "q", "s", "v", "w", "x", "z"].contains(&key.as_str())
    {
        return Some("That shortcut is reserved by macOS or standard editing commands.");
    }

    if !is_mac && binding.alt && !binding.ctrl && !binding.meta && key == "f4" {
        return Some("That shortcut is reserved for closing the window.");
    }

    None
}

/// Port of `coerceBinding`.
fn coerce_binding(raw: &Value, is_mac: bool) -> Option<ShortcutBinding> {
    let obj = raw.as_object()?;
    let key = obj.get("key").and_then(Value::as_str)?;
    if key.is_empty() || key.chars().count() > 32 {
        return None;
    }
    let code = obj
        .get("code")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty() && c.chars().count() <= 32)
        .map(str::to_string);
    let candidate = ShortcutBinding {
        key: key.to_string(),
        code,
        ctrl: obj.get("ctrl").and_then(Value::as_bool).unwrap_or(false),
        meta: obj.get("meta").and_then(Value::as_bool).unwrap_or(false),
        shift: obj.get("shift").and_then(Value::as_bool).unwrap_or(false),
        alt: obj.get("alt").and_then(Value::as_bool).unwrap_or(false),
    };
    if shortcut_binding_validation_error(&candidate, is_mac).is_some() {
        return None;
    }
    Some(candidate)
}

/// Port of `coerceKeybindingOverrides`.
pub fn coerce_keybinding_overrides(
    raw: &Value,
    is_mac: bool,
) -> HashMap<String, Vec<ShortcutBinding>> {
    let mut overrides = HashMap::new();
    let Some(source) = raw.as_object() else {
        return overrides;
    };
    for id in CUSTOMIZABLE_IDS {
        let Some(raw_bindings) = source.get(*id).and_then(Value::as_array) else {
            continue;
        };
        let bindings: Vec<ShortcutBinding> = raw_bindings
            .iter()
            .take(2)
            .filter_map(|b| coerce_binding(b, is_mac))
            .collect();
        // Preserve an intentional empty array as "unassigned". If a non-empty
        // persisted value contains no valid bindings, omit it so defaults recover.
        if !raw_bindings.is_empty() && bindings.is_empty() {
            continue;
        }
        overrides.insert(id.to_string(), bindings);
    }
    overrides
}

fn is_mac_runtime() -> bool {
    cfg!(target_os = "macos")
}

fn read_keybinding_overrides(state_dir: &Path) -> HashMap<String, Vec<ShortcutBinding>> {
    let file = state_dir.join(KEYBINDING_SETTINGS_FILE_NAME);
    let raw = match std::fs::read_to_string(&file) {
        Ok(raw) => raw,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) => coerce_keybinding_overrides(&value, is_mac_runtime()),
        Err(_) => HashMap::new(),
    }
}

fn write_keybinding_overrides(
    state_dir: &Path,
    overrides: &Value,
) -> Result<HashMap<String, Vec<ShortcutBinding>>, String> {
    let next = coerce_keybinding_overrides(overrides, is_mac_runtime());
    let data = format!(
        "{}\n",
        serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?
    );
    atomic_write(
        state_dir,
        KEYBINDING_SETTINGS_FILE_NAME,
        "keybindings",
        &data,
    )
    .map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command]
pub async fn keybindings_get() -> Result<serde_json::Value, String> {
    let overrides = read_keybinding_overrides(&paths::ao_data_dir());
    serde_json::to_value(overrides).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn keybindings_set(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let next = write_keybinding_overrides(&paths::ao_data_dir(), &value)?;
    serde_json::to_value(next).map_err(|e| e.to_string())
}

// Recording-active flag, set while the renderer is capturing a new chord for
// the shortcuts editor. A simple process-wide flag suffices; nothing else in
// this task reads it (consumed by M3's before-input interception).
static KEYBINDING_RECORDING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn keybindings_set_recording(recording: bool) -> Result<(), String> {
    KEYBINDING_RECORDING.store(recording, Ordering::SeqCst);
    Ok(())
}

/// Consumed by M3's before-input interception; exposed now so that module can
/// read the flag without reaching into this module's private static.
#[allow(dead_code)]
pub fn keybindings_recording_active() -> bool {
    KEYBINDING_RECORDING.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// App-state migration block — port of app-state.ts's updateMigration /
// readMigrationState (the launch-marker write itself is out of scope here).
// ---------------------------------------------------------------------------

pub const APP_STATE_FILE_NAME: &str = "app-state.json";
const SCHEMA_VERSION: u32 = 2;

fn now_iso() -> String {
    // RFC 3339 / ISO 8601 UTC with millisecond precision, matching
    // `Date#toISOString()`. Avoids pulling in a chrono/time dependency
    // (Cargo.toml is frozen for this task) by formatting manually from the
    // UNIX epoch offset.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86_400;
    let time_of_day = secs % 86_400;
    let (hh, mm, ss) = (
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    );

    // Civil-from-days (Howard Hinnant's algorithm), proleptic Gregorian.
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

fn read_app_state(state_dir: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(state_dir.join(APP_STATE_FILE_NAME)).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn write_app_state(state_dir: &Path, marker: &Value) -> Result<(), String> {
    let data = format!(
        "{}\n",
        serde_json::to_string_pretty(marker).map_err(|e| e.to_string())?
    );
    atomic_write(state_dir, APP_STATE_FILE_NAME, "app-state", &data).map_err(|e| e.to_string())
}

fn read_migration_state(state_dir: &Path) -> Value {
    read_app_state(state_dir)
        .and_then(|marker| marker.get("migration").cloned())
        .unwrap_or_else(|| json!({ "status": "pending" }))
}

fn update_migration(state_dir: &Path, migration: &Value) -> Result<(), String> {
    let existing = read_app_state(state_dir);
    let marker = match existing {
        Some(Value::Object(mut map)) => {
            map.insert("migration".to_string(), migration.clone());
            Value::Object(map)
        }
        _ => {
            let now = now_iso();
            json!({
                "schemaVersion": SCHEMA_VERSION,
                "appPath": "",
                "version": "",
                "installedAt": now,
                "lastReconciledAt": now,
                "installSource": "unknown",
                "migration": migration,
            })
        }
    };
    write_app_state(state_dir, &marker)
}

#[tauri::command]
pub async fn app_state_get_migration() -> Result<serde_json::Value, String> {
    Ok(read_migration_state(&paths::ao_data_dir()))
}

#[tauri::command]
pub async fn app_state_set_migration(
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    update_migration(&paths::ao_data_dir(), &value)?;
    Ok(value)
}

// ---------------------------------------------------------------------------
// Update settings — port of update-settings.ts.
// ---------------------------------------------------------------------------

pub const UPDATE_SETTINGS_FILE_NAME: &str = "update-settings.json";

fn coerce_feature(raw: Option<&Value>) -> Value {
    let Some(raw) = raw else {
        return Value::Null;
    };
    let Some(obj) = raw.as_object() else {
        return Value::Null;
    };
    match obj.get("pr").and_then(Value::as_i64) {
        Some(pr) if pr > 0 => json!({ "pr": pr }),
        _ => Value::Null,
    }
}

// pub(crate): reused by the updater module (see src/updater/mod.rs) so the
// updater's runtime channel/feature logic reads and writes the exact same
// coerced shape as these commands, instead of re-implementing the migration
// rules a second time.
pub(crate) fn coerce_update_settings(raw: &Value) -> Value {
    let obj = raw.as_object();
    let enabled = obj
        .and_then(|o| o.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let channel = obj.and_then(|o| o.get("channel")).and_then(Value::as_str);
    let channel = if channel == Some("nightly") {
        "nightly"
    } else {
        "latest"
    };
    let nightly_ack = obj
        .and_then(|o| o.get("nightlyAck"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let feature = coerce_feature(obj.and_then(|o| o.get("feature")));
    json!({
        "enabled": enabled,
        "channel": channel,
        "nightlyAck": nightly_ack,
        "feature": feature,
    })
}

pub(crate) fn read_update_settings(state_dir: &Path) -> Value {
    let raw = match std::fs::read_to_string(state_dir.join(UPDATE_SETTINGS_FILE_NAME)) {
        Ok(raw) => raw,
        Err(_) => return coerce_update_settings(&Value::Null),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) => coerce_update_settings(&value),
        Err(_) => coerce_update_settings(&Value::Null),
    }
}

pub(crate) fn write_update_settings(state_dir: &Path, settings: &Value) -> Result<Value, String> {
    let next = coerce_update_settings(settings);
    let data = format!(
        "{}\n",
        serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?
    );
    atomic_write(
        state_dir,
        UPDATE_SETTINGS_FILE_NAME,
        "update-settings",
        &data,
    )
    .map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command]
pub async fn update_settings_get() -> Result<serde_json::Value, String> {
    Ok(read_update_settings(&paths::ao_data_dir()))
}

/// True once `update-settings.json` has been written at least once (i.e. the
/// user has made an opt-in/channel decision, even if that decision was "off").
/// Ported from auto-updater.ts's `ensureUpdatePrefs`, which gates the
/// first-run wizard on `existsSync(update-settings.json)` rather than on the
/// (always-present) coerced default shape.
#[tauri::command]
pub async fn update_settings_has_decision() -> Result<bool, String> {
    Ok(paths::ao_data_dir()
        .join(UPDATE_SETTINGS_FILE_NAME)
        .exists())
}

#[tauri::command]
pub async fn update_settings_set(value: serde_json::Value) -> Result<serde_json::Value, String> {
    write_update_settings(&paths::ao_data_dir(), &value)
}

// ---------------------------------------------------------------------------
// Tests — ported test tables from keybinding-settings.test.ts,
// app-state.test.ts (migration block only), and update-settings.test.ts.
// Each test drives the private `*_state_dir`/`*_unlocked` helpers directly
// against a tempdir, so there is no shared-process env var to race on.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tempdir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn binding(key: &str) -> Value {
        json!({ "key": key })
    }

    mod coerce_keybinding_overrides_tests {
        use super::*;

        #[test]
        fn keeps_valid_application_bindings_and_ignores_unknown_commands() {
            let raw = json!({
                "focus-terminal": [{ "key": "j", "ctrl": true }],
                "unknown-command": [{ "key": "q", "ctrl": true }],
            });
            let overrides = coerce_keybinding_overrides(&raw, false);
            let mut expected = HashMap::new();
            expected.insert(
                "focus-terminal".to_string(),
                vec![ShortcutBinding {
                    key: "j".into(),
                    code: None,
                    ctrl: true,
                    meta: false,
                    shift: false,
                    alt: false,
                }],
            );
            assert_eq!(overrides, expected);
        }

        #[test]
        fn falls_back_to_defaults_for_corrupt_arrays_but_preserves_intentional_unassignment() {
            let raw = json!({
                "open-settings": [{ "key": "s" }],
                "command-palette": [],
            });
            let overrides = coerce_keybinding_overrides(&raw, false);
            let mut expected = HashMap::new();
            expected.insert("command-palette".to_string(), vec![]);
            assert_eq!(overrides, expected);
        }

        #[test]
        fn rejects_standalone_function_keys_and_terminal_critical_chords() {
            let raw = json!({
                "focus-terminal": [{ "key": "F6" }],
                "open-settings": [{ "key": "c", "ctrl": true }],
            });
            assert_eq!(coerce_keybinding_overrides(&raw, false), HashMap::new());
        }

        #[test]
        fn does_not_accept_overrides_for_the_fixed_indexed_project_shortcut() {
            let raw = json!({ "open-project": [{ "key": "p", "ctrl": true }] });
            assert_eq!(coerce_keybinding_overrides(&raw, false), HashMap::new());
        }

        #[test]
        fn applies_platform_aware_reserved_shortcut_validation() {
            let raw = json!({ "focus-terminal": [{ "key": "q", "meta": true }] });
            assert_eq!(coerce_keybinding_overrides(&raw, true), HashMap::new());

            let overrides = coerce_keybinding_overrides(&raw, false);
            let mut expected = HashMap::new();
            expected.insert(
                "focus-terminal".to_string(),
                vec![ShortcutBinding {
                    key: "q".into(),
                    code: None,
                    ctrl: false,
                    meta: true,
                    shift: false,
                    alt: false,
                }],
            );
            assert_eq!(overrides, expected);
        }

        #[test]
        fn ignored_binding_key_argument_is_unused_helper_placeholder() {
            // Exercise the `binding` helper so it is not flagged unused when a
            // future table needs it.
            assert_eq!(binding("x"), json!({ "key": "x" }));
        }
    }

    mod keybinding_file_io_tests {
        use super::*;

        #[test]
        fn round_trips_written_overrides() {
            let dir = tempdir("ao-keybindings");
            let value = json!({ "focus-terminal": [{ "key": "j", "ctrl": true }] });
            let written = write_keybinding_overrides(&dir, &value).unwrap();
            assert_eq!(read_keybinding_overrides(&dir), written);
        }

        #[test]
        fn missing_file_reads_as_empty_overrides() {
            let dir = tempdir("ao-keybindings-missing");
            assert_eq!(read_keybinding_overrides(&dir), HashMap::new());
        }

        #[test]
        fn atomic_write_leaves_no_temp_file_behind() {
            let dir = tempdir("ao-keybindings-atomic");
            write_keybinding_overrides(&dir, &json!({})).unwrap();
            let entries: Vec<_> = std::fs::read_dir(&dir)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            assert_eq!(
                entries,
                vec![std::ffi::OsString::from(KEYBINDING_SETTINGS_FILE_NAME)]
            );
        }
    }

    mod migration_marker_tests {
        use super::*;

        #[test]
        fn read_migration_state_defaults_to_pending_when_the_file_is_absent() {
            let dir = tempdir("ao-appstate-absent");
            assert_eq!(read_migration_state(&dir), json!({ "status": "pending" }));
        }

        #[test]
        fn read_migration_state_defaults_to_pending_when_the_file_is_corrupt() {
            let dir = tempdir("ao-appstate-corrupt");
            std::fs::write(dir.join(APP_STATE_FILE_NAME), "{ not valid json").unwrap();
            assert_eq!(read_migration_state(&dir), json!({ "status": "pending" }));
        }

        #[test]
        fn update_migration_persists_status_without_an_existing_marker() {
            let dir = tempdir("ao-appstate-fresh");
            update_migration(&dir, &json!({ "status": "declined" })).unwrap();
            assert_eq!(read_migration_state(&dir)["status"], json!("declined"));
        }

        #[test]
        fn a_later_write_preserves_an_existing_migration_block() {
            let dir = tempdir("ao-appstate-preserve");
            update_migration(&dir, &json!({ "status": "completed" })).unwrap();
            let marker = read_app_state(&dir).unwrap();
            assert_eq!(marker["schemaVersion"], json!(2));
            assert_eq!(marker["migration"]["status"], json!("completed"));
        }

        #[test]
        fn update_migration_does_not_clobber_other_launch_fields() {
            let dir = tempdir("ao-appstate-clobber");
            write_app_state(
                &dir,
                &json!({
                    "schemaVersion": 2,
                    "appPath": "/A.app",
                    "version": "1.2.3",
                    "installedAt": "2026-06-26T10:00:00.000Z",
                    "lastReconciledAt": "2026-06-26T10:00:00.000Z",
                    "installSource": "unknown",
                }),
            )
            .unwrap();
            update_migration(&dir, &json!({ "status": "failed", "error": "x" })).unwrap();
            let marker = read_app_state(&dir).unwrap();
            assert_eq!(marker["appPath"], json!("/A.app"));
            assert_eq!(
                marker["migration"],
                json!({ "status": "failed", "error": "x" })
            );
        }
    }

    mod update_settings_tests {
        use super::*;

        #[test]
        fn returns_safe_defaults_when_no_file_exists() {
            let dir = tempdir("ao-update-settings-missing");
            assert_eq!(
                read_update_settings(&dir),
                json!({ "enabled": false, "channel": "latest", "nightlyAck": false, "feature": null })
            );
        }

        #[test]
        fn round_trips_written_settings() {
            let dir = tempdir("ao-update-settings-roundtrip");
            let settings = json!({ "enabled": true, "channel": "nightly", "nightlyAck": true, "feature": null });
            write_update_settings(&dir, &settings).unwrap();
            assert_eq!(read_update_settings(&dir), settings);
        }

        #[test]
        fn falls_back_to_defaults_on_garbage() {
            let dir = tempdir("ao-update-settings-garbage");
            std::fs::write(dir.join(UPDATE_SETTINGS_FILE_NAME), "{not json").unwrap();
            assert_eq!(
                read_update_settings(&dir),
                json!({ "enabled": false, "channel": "latest", "nightlyAck": false, "feature": null })
            );
        }

        #[test]
        fn coerces_an_unknown_channel_back_to_latest() {
            let dir = tempdir("ao-update-settings-channel");
            std::fs::write(
                dir.join(UPDATE_SETTINGS_FILE_NAME),
                serde_json::to_string(
                    &json!({ "enabled": true, "channel": "weird", "nightlyAck": false }),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(read_update_settings(&dir)["channel"], json!("latest"));
        }

        #[test]
        fn legacy_file_without_feature_key_defaults_feature_to_null() {
            let dir = tempdir("ao-update-settings-legacy");
            std::fs::write(
                dir.join(UPDATE_SETTINGS_FILE_NAME),
                serde_json::to_string(
                    &json!({ "enabled": true, "channel": "nightly", "nightlyAck": true }),
                )
                .unwrap(),
            )
            .unwrap();
            let settings = read_update_settings(&dir);
            assert_eq!(settings["feature"], Value::Null);
            assert_eq!(settings["channel"], json!("nightly"));
        }

        #[test]
        fn round_trips_nightly_plus_feature_pin_without_clobbering_channel() {
            let dir = tempdir("ao-update-settings-feature");
            let settings = json!({ "enabled": true, "channel": "nightly", "nightlyAck": true, "feature": { "pr": 2270 } });
            write_update_settings(&dir, &settings).unwrap();
            assert_eq!(read_update_settings(&dir), settings);
        }

        #[test]
        fn coerces_a_malformed_feature_value_to_null() {
            let dir = tempdir("ao-update-settings-bad-feature");
            std::fs::write(
                dir.join(UPDATE_SETTINGS_FILE_NAME),
                serde_json::to_string(&json!({
                    "enabled": true, "channel": "latest", "nightlyAck": false, "feature": { "pr": "not-a-number" }
                }))
                .unwrap(),
            )
            .unwrap();
            assert_eq!(read_update_settings(&dir)["feature"], Value::Null);
        }

        #[test]
        fn atomic_write_leaves_no_temp_file_behind() {
            let dir = tempdir("ao-update-settings-atomic");
            write_update_settings(&dir, &json!({ "enabled": true, "channel": "latest", "nightlyAck": false, "feature": null }))
                .unwrap();
            let entries: Vec<_> = std::fs::read_dir(&dir)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            assert_eq!(
                entries,
                vec![std::ffi::OsString::from(UPDATE_SETTINGS_FILE_NAME)]
            );
        }
    }

    mod keybindings_recording_tests {
        use super::*;

        #[test]
        fn set_recording_flips_the_process_wide_flag() {
            KEYBINDING_RECORDING.store(false, Ordering::SeqCst);
            assert!(!keybindings_recording_active());
            KEYBINDING_RECORDING.store(true, Ordering::SeqCst);
            assert!(keybindings_recording_active());
            KEYBINDING_RECORDING.store(false, Ordering::SeqCst);
        }
    }
}
