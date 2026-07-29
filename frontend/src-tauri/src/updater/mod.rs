// Auto-update: channel/feature-build resolution, escalation, and the
// `updates_*` / `feature_builds_*` commands.
//
// Ported from (semantics only):
//   - frontend/src/main/auto-updater.ts (+ .test.ts) — status state machine,
//     serialized updater operations, hourly automatic check.
//   - frontend/src/main/update-settings.ts — settings persistence (already
//     ported to `crate::settings`; reused here, not re-implemented).
//   - frontend/src/main/escalation-evaluator.ts (+ .test.ts) — see
//     `escalation.rs`.
//   - frontend/src/main/feature-builds.ts (+ .test.ts) — see
//     `feature_builds.rs`.
//
// Endpoint construction, tokio-mutex operation serialization, status
// broadcast over `updates://status`, and the hourly automatic-check timer are
// this module's own responsibility. Manifest signing/generation is T11 (CI);
// this module only reads a channel -> URL mapping and delegates signature
// verification to `tauri-plugin-updater`.

mod escalation;
mod feature_builds;

pub use feature_builds::FeatureBuild;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex as SyncMutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex as AsyncMutex;

use crate::paths;
use crate::settings;

/// Repo the update feed and feature-build list are read from. Overridable at
/// build time via `AO_RELEASE_REPO` (owner/repo); defaults to the upstream
/// repo, matching forge.config.ts's DEFAULT_RELEASE_REPO on the Electron side.
fn release_repo() -> (String, String) {
    let raw = option_env!("AO_RELEASE_REPO").unwrap_or("AgentWrapper/agent-orchestrator");
    match raw.split_once('/') {
        Some((owner, repo)) => (owner.to_string(), repo.to_string()),
        None => ("AgentWrapper".to_string(), "agent-orchestrator".to_string()),
    }
}

/// Maps the current channel/feature-pin to a manifest URL. See T10 spec:
/// `latest` -> `.../releases/latest/download/latest.json`, `nightly` ->
/// `.../releases/download/nightly/nightly.json`, `pr<N>` ->
/// `.../releases/download/pr<N>/pr-<N>.json`.
fn channel_endpoint(channel: &str, feature_pr: Option<i64>) -> String {
    let (owner, repo) = release_repo();
    if let Some(pr) = feature_pr {
        return format!("https://github.com/{owner}/{repo}/releases/download/pr{pr}/pr-{pr}.json");
    }
    match channel {
        "nightly" => {
            format!("https://github.com/{owner}/{repo}/releases/download/nightly/nightly.json")
        }
        _ => format!("https://github.com/{owner}/{repo}/releases/latest/download/latest.json"),
    }
}

// ---------------------------------------------------------------------------
// UpdateStatus — field names/casing must byte-match `UpdateStatus` in
// frontend/src/shared/bridge-types.ts.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub escalated: Option<bool>,
}

impl Default for UpdateStatus {
    /// The idle/no-op state — must be a valid `UpdateState` per
    /// frontend/src/shared/bridge-types.ts (`""` is not a member of that
    /// union), unlike the derived `String::default()`.
    fn default() -> Self {
        UpdateStatus {
            state: "idle".to_string(),
            version: None,
            percent: None,
            message: None,
            request_id: None,
            staged_at: None,
            escalated: None,
        }
    }
}

impl UpdateStatus {
    fn state_only(state: &str, request_id: Option<String>) -> Self {
        UpdateStatus {
            state: state.to_string(),
            request_id,
            ..Default::default()
        }
    }

    fn error(message: impl Into<String>, request_id: Option<String>) -> Self {
        UpdateStatus {
            state: "error".to_string(),
            message: Some(message.into()),
            request_id,
            ..Default::default()
        }
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckOptions {
    #[serde(default)]
    pub settings: Option<Value>,
    #[serde(default)]
    pub request_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/// Serializes check/download/install so at most one updater operation runs at
/// a time (mirrors the Electron promise-queue in auto-updater.ts).
#[derive(Default)]
pub struct UpdaterState {
    pub last_status: SyncMutex<UpdateStatus>,
    pub staged: SyncMutex<Option<StagedBuild>>,
    pub operation_lock: AsyncMutex<()>,
}

pub struct StagedBuild {
    pub version: String,
    pub staged_at_ms: i64,
    pub escalated: bool,
}

/// The `Update` handle and downloaded bytes of a not-yet-installed update,
/// staged by `updates_download` and consumed by `updates_install`. Keeping
/// the handle avoids re-running `updater.check()` (a network call) at
/// install time; on install failure the pair is left in place so the user
/// can retry without re-downloading.
#[derive(Default)]
pub struct PendingInstall(pub SyncMutex<Option<(Update, Vec<u8>)>>);

/// Ensures at most one escalation-recheck loop runs at a time, even if
/// `updates_download` is called multiple times while a build is staged.
static ESCALATION_LOOP_RUNNING: AtomicBool = AtomicBool::new(false);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn broadcast(app: &AppHandle, state: &State<'_, UpdaterState>, status: UpdateStatus) {
    *state.last_status.lock().unwrap() = status.clone();
    let _ = app.emit("updates://status", &status);
}

fn current_settings() -> Value {
    settings::read_update_settings(&paths::ao_data_dir())
}

fn settings_channel(settings: &Value) -> String {
    settings
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("latest")
        .to_string()
}

fn settings_feature_pr(settings: &Value) -> Option<i64> {
    settings
        .get("feature")
        .and_then(|f| if f.is_null() { None } else { f.get("pr") })
        .and_then(Value::as_i64)
}

fn settings_enabled(settings: &Value) -> bool {
    settings
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

async fn build_updater(
    app: &AppHandle,
    endpoint: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    let url = url::Url::parse(endpoint).map_err(|e| e.to_string())?;
    let builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?;
    builder.build().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn updates_get_status(state: State<'_, UpdaterState>) -> Result<UpdateStatus, String> {
    Ok(state.last_status.lock().unwrap().clone())
}

#[tauri::command]
pub async fn updates_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    options: Option<UpdateCheckOptions>,
) -> Result<(), String> {
    let options = options.unwrap_or_default();
    let _guard = state.operation_lock.lock().await;

    if let Some(new_settings) = &options.settings {
        settings::write_update_settings(&paths::ao_data_dir(), new_settings)?;
    }
    let settings = current_settings();

    broadcast(
        &app,
        &state,
        UpdateStatus::state_only("checking", options.request_id.clone()),
    );

    let endpoint = channel_endpoint(&settings_channel(&settings), settings_feature_pr(&settings));
    let status = match build_updater(&app, &endpoint).await {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => UpdateStatus {
                state: "available".to_string(),
                version: Some(update.version.clone()),
                request_id: options.request_id.clone(),
                ..Default::default()
            },
            Ok(None) => UpdateStatus::state_only("not-available", options.request_id.clone()),
            Err(err) => UpdateStatus::error(err.to_string(), options.request_id.clone()),
        },
        Err(err) => UpdateStatus::error(err, options.request_id.clone()),
    };
    broadcast(&app, &state, status);
    Ok(())
}

#[tauri::command]
pub async fn updates_return_home(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    request_id: Option<String>,
) -> Result<(), String> {
    {
        let _guard = state.operation_lock.lock().await;
        let current = current_settings();
        if settings_feature_pr(&current).is_some() {
            let mut cleared = current.clone();
            if let Some(obj) = cleared.as_object_mut() {
                obj.insert("feature".to_string(), Value::Null);
            }
            settings::write_update_settings(&paths::ao_data_dir(), &cleared)?;
        }
    }
    updates_check(
        app,
        state,
        Some(UpdateCheckOptions {
            settings: None,
            request_id,
        }),
    )
    .await
}

#[tauri::command]
pub async fn updates_download(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    pending: State<'_, PendingInstall>,
    request_id: Option<String>,
) -> Result<(), String> {
    let _guard = state.operation_lock.lock().await;
    let settings = current_settings();
    let endpoint = channel_endpoint(&settings_channel(&settings), settings_feature_pr(&settings));
    let updater = build_updater(&app, &endpoint).await?;
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            broadcast(
                &app,
                &state,
                UpdateStatus::state_only("not-available", request_id),
            );
            return Ok(());
        }
        Err(err) => {
            broadcast(
                &app,
                &state,
                UpdateStatus::error(err.to_string(), request_id),
            );
            return Ok(());
        }
    };

    let downloaded_bytes = std::sync::Arc::new(AtomicUsize::new(0));
    let progress_app = app.clone();
    let progress_last_status = &state.last_status;
    let progress_version = update.version.clone();
    let progress_request_id = request_id.clone();

    let result = update
        .download(
            move |chunk_len, total| {
                let so_far = downloaded_bytes.fetch_add(chunk_len, Ordering::Relaxed) + chunk_len;
                let percent = total.filter(|t| *t > 0).map(|t| {
                    ((so_far as f64 / t as f64) * 100.0)
                        .round()
                        .clamp(0.0, 100.0) as u32
                });
                let status = UpdateStatus {
                    state: "downloading".to_string(),
                    version: Some(progress_version.clone()),
                    percent,
                    request_id: progress_request_id.clone(),
                    ..Default::default()
                };
                *progress_last_status.lock().unwrap() = status.clone();
                let _ = progress_app.emit("updates://status", &status);
            },
            || {},
        )
        .await;

    match result {
        Ok(bytes) => {
            let staged_at_ms = now_ms();
            *state.staged.lock().unwrap() = Some(StagedBuild {
                version: update.version.clone(),
                staged_at_ms,
                escalated: false,
            });
            *pending.0.lock().unwrap() = Some((update.clone(), bytes));
            broadcast(
                &app,
                &state,
                UpdateStatus {
                    state: "downloaded".to_string(),
                    version: Some(update.version.clone()),
                    staged_at: Some(staged_at_ms),
                    escalated: Some(false),
                    request_id,
                    ..Default::default()
                },
            );
            spawn_escalation_recheck_loop(app.clone());
        }
        Err(err) => {
            broadcast(
                &app,
                &state,
                UpdateStatus::error(err.to_string(), request_id),
            );
        }
    }
    Ok(())
}

/// Re-evaluates escalation every 30 minutes while a build sits staged
/// (mirrors auto-updater.ts's `runEscalationCheck` timer). Manifest-level
/// hints (the nightly "important" flag, latest-stable-version lookup) are
/// T11 concerns once signed manifests exist; until then this only drives the
/// "latest" channel's 48h escalation rule, which needs no network fetch.
fn spawn_escalation_recheck_loop(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    // Only one recheck loop should ever be live: `updates_download` may be
    // called again (e.g. a retry) while a previous loop is still ticking for
    // an earlier staged build.
    if ESCALATION_LOOP_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30 * 60));
        interval.tick().await; // consume the immediate first tick
        loop {
            interval.tick().await;
            let Some(state) = app.try_state::<UpdaterState>() else {
                ESCALATION_LOOP_RUNNING.store(false, Ordering::SeqCst);
                return;
            };
            let still_staged = {
                let mut staged_guard = state.staged.lock().unwrap();
                let Some(staged) = staged_guard.as_mut() else {
                    drop(staged_guard);
                    ESCALATION_LOOP_RUNNING.store(false, Ordering::SeqCst);
                    return;
                };
                let settings = current_settings();
                let channel = settings_channel(&settings);
                let running_version = app.package_info().version.to_string();
                staged.escalated = escalation::evaluate_escalation(escalation::EscalationInput {
                    channel: &channel,
                    staged_at: staged.staged_at_ms,
                    now: now_ms(),
                    important: false,
                    running_version: &running_version,
                    latest_stable_version: None,
                });
                Some((
                    staged.version.clone(),
                    staged.staged_at_ms,
                    staged.escalated,
                ))
            };
            if let Some((version, staged_at, escalated)) = still_staged {
                broadcast(
                    &app,
                    &state,
                    UpdateStatus {
                        state: "downloaded".to_string(),
                        version: Some(version),
                        staged_at: Some(staged_at),
                        escalated: Some(escalated),
                        ..Default::default()
                    },
                );
            }
        }
    });
}

#[tauri::command]
pub async fn updates_install(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    pending: State<'_, PendingInstall>,
) -> Result<(), String> {
    let _guard = state.operation_lock.lock().await;
    // Take a clone of the pending pair rather than `.take()`-ing it: if
    // `install` fails below, the staged update/bytes must remain available
    // for a retry instead of being dropped and forcing a re-download.
    let pending_pair = pending.0.lock().unwrap().clone();
    let Some((update, bytes)) = pending_pair else {
        return Err("no downloaded update staged".to_string());
    };
    update.install(bytes).map_err(|e| e.to_string())?;
    *pending.0.lock().unwrap() = None;
    *state.staged.lock().unwrap() = None;
    app.request_restart();
    Ok(())
}

#[tauri::command]
pub async fn feature_builds_list() -> Result<Vec<FeatureBuild>, String> {
    let (owner, repo) = release_repo();
    let client = reqwest::Client::new();
    let user_agent = format!("ao-desktop/{}", env!("CARGO_PKG_VERSION"));
    Ok(
        feature_builds::collect_feature_builds(&client, &owner, &repo, &user_agent, now_ms())
            .await
            .unwrap_or_default(),
    )
}

#[tauri::command]
pub async fn feature_builds_get_active(app: AppHandle) -> Result<Option<i64>, String> {
    Ok(feature_builds::parse_feature_build(
        &app.package_info().version.to_string(),
    ))
}

/// Starts the hourly automatic-update-check timer. Call once from `lib.rs`'s
/// `.setup()`. Whether a check actually runs is re-evaluated on every tick
/// (not just at startup), so enabling auto-updates later in Settings takes
/// effect on the next tick without an app restart.
///
/// No-ops in debug builds: auto-updates should only run in packaged builds,
/// matching the wizard's `import.meta.env.PROD` gate on the renderer side.
pub fn start_automatic_check_timer(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
        interval.tick().await; // first tick fires immediately; the launch-time check (if any) is separate
        loop {
            interval.tick().await;
            let settings = current_settings();
            if !settings_enabled(&settings) {
                continue;
            }
            let Some(state) = app.try_state::<UpdaterState>() else {
                continue;
            };
            let _ = updates_check(app.clone(), state, None).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_status_serializes_camelcase_and_matches_bridge_types() {
        let status = UpdateStatus {
            state: "downloaded".to_string(),
            version: Some("1.2.3".to_string()),
            percent: None,
            message: None,
            request_id: Some("req-1".to_string()),
            staged_at: Some(1_700_000_000_000),
            escalated: Some(true),
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["state"], "downloaded");
        assert_eq!(value["version"], "1.2.3");
        assert_eq!(value["requestId"], "req-1");
        assert_eq!(value["stagedAt"], 1_700_000_000_000i64);
        assert_eq!(value["escalated"], true);
        // percent/message are None -> omitted entirely (matches the optional
        // fields in bridge-types.ts's UpdateStatus).
        assert!(value.get("percent").is_none());
        assert!(value.get("message").is_none());
    }

    #[test]
    fn update_status_default_is_idle() {
        let status = UpdateStatus::default();
        assert_eq!(status.state, "idle");
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["state"], "idle");
        // "" is not a member of UpdateState in bridge-types.ts; only "idle" is
        // a valid default.
        assert!(value.get("version").is_none());
    }

    #[test]
    fn channel_endpoint_maps_latest_nightly_and_feature_channels() {
        assert!(channel_endpoint("latest", None).ends_with("/releases/latest/download/latest.json"));
        assert!(
            channel_endpoint("nightly", None).ends_with("/releases/download/nightly/nightly.json")
        );
        assert!(channel_endpoint("latest", Some(2270))
            .ends_with("/releases/download/pr2270/pr-2270.json"));
    }
}
