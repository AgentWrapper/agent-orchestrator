// Daemon supervision: resolves the `ao` binary, runs `ao daemon ensure --owner
// app --json` to attach/spawn/take-over the local AO daemon, holds the
// supervise-socket connection that keeps it alive for the app's lifetime, and
// exposes the start/stop/restart/status commands + `daemon://status` events the
// renderer expects.
//
// Ported from (semantics only — this is a from-scratch Rust implementation,
// not a transliteration):
//   - frontend/src/shared/daemon-launch.ts   (binary resolution)
//   - frontend/src/shared/daemon-status.ts   (the DaemonStatus wire shape)
//   - frontend/src/main/supervisor-link.ts   (holding the supervise-socket fd)
//   - frontend/src/main/daemon-owner.ts      (link-on-attach policy)
//   - frontend/src/shared/shell-env.ts       (login-shell PATH probe)
//   - frontend/src/main.ts lines 453-481     (daemonEnv()) and 562-585
//     (supervisorPipeFromRunFile / establishSupervisorLink)
//
// The Go side (backend/internal/cli/daemon_ensure.go) already implements the
// attach/spawn/takeover decision and prints a single JSON line
// `{"port":N,"pid":N,"mode":"attached"|"spawned"|"takeover"}` on success, so
// this module's job is invoking that command correctly, not re-implementing
// its decision logic.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use interprocess::local_socket::{
    tokio::{prelude::*, Stream as SupervisorStream},
    GenericFilePath,
};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::shell_env::{build_daemon_env, resolve_shell_env, BoxFuture, ShellRunner};

// ---------------------------------------------------------------------------
// DaemonStatus — must byte-match the field names in
// frontend/src/shared/daemon-status.ts.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub state: String, // "starting" | "ready" | "stopped" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

impl Default for DaemonStatus {
    fn default() -> Self {
        DaemonStatus {
            state: "stopped".to_string(),
            port: None,
            pid: None,
            executable_path: None,
            working_directory: None,
            message: None,
            details: None,
            code: None,
            exit_code: None,
            signal: None,
        }
    }
}

impl DaemonStatus {
    fn stopped() -> Self {
        DaemonStatus::default()
    }

    fn starting() -> Self {
        DaemonStatus { state: "starting".to_string(), ..Default::default() }
    }

    fn error(code: &str, message: impl Into<String>) -> Self {
        DaemonStatus { state: "error".to_string(), code: Some(code.to_string()), message: Some(message.into()), ..Default::default() }
    }
}

/// Machine-readable failure classification, matching
/// frontend/src/shared/daemon-status.ts's `DaemonFailureCode` union values.
pub mod failure_code {
    pub const NOT_CONFIGURED: &str = "not_configured";
    pub const BINARY_MISSING: &str = "binary_missing";
    pub const SPAWN_FAILED: &str = "spawn_failed";
    pub const DAEMON_UNREACHABLE: &str = "daemon_unreachable";
}

// ---------------------------------------------------------------------------
// Binary resolution — pure port of
// frontend/src/shared/daemon-launch.ts#resolveDaemonLaunch.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchSource {
    Configured,
    Dev,
    Bundled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonLaunchSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub shell: bool,
    pub source: LaunchSource,
}

/// Mirrors daemon-launch.ts's `joinPath`: strips only trailing slashes from
/// each segment, then joins with `/` (never resolves `..`, matching the TS
/// behavior of leaving cwd resolution to the OS).
fn join_path(segments: &[&str]) -> String {
    segments
        .iter()
        .map(|s| s.trim_end_matches(['/', '\\']))
        .collect::<Vec<_>>()
        .join("/")
}

pub fn bundled_daemon_binary_name(is_windows: bool) -> &'static str {
    if is_windows {
        "ao.exe"
    } else {
        "ao"
    }
}

/// Pure port of `resolveDaemonLaunch`. Kept parameter-for-parameter compatible
/// with the TS signature (env override / dev / bundled sidecar) so the ported
/// test table below matches 1:1.
pub fn resolve_daemon_launch(
    env: &HashMap<String, String>,
    is_packaged: bool,
    resources_path: &str,
    app_path: &str,
    home_dir: &str,
    is_windows: bool,
) -> Option<DaemonLaunchSpec> {
    if let Some(configured) = env.get("AO_DAEMON_COMMAND").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return Some(DaemonLaunchSpec {
            command: configured.to_string(),
            args: vec![],
            cwd: app_path.to_string(),
            shell: true,
            source: LaunchSource::Configured,
        });
    }

    if !is_packaged {
        return Some(DaemonLaunchSpec {
            command: "go".to_string(),
            args: vec!["run".to_string(), "./cmd/ao".to_string(), "daemon".to_string()],
            cwd: join_path(&[app_path, "..", "backend"]),
            shell: false,
            source: LaunchSource::Dev,
        });
    }

    Some(DaemonLaunchSpec {
        command: join_path(&[resources_path, "daemon", bundled_daemon_binary_name(is_windows)]),
        args: vec!["daemon".to_string()],
        cwd: join_path(&[home_dir, ".ao"]),
        shell: false,
        source: LaunchSource::Bundled,
    })
}

/// Walks up from `start`, returning `<ancestor>/backend` the first time
/// `<ancestor>/backend/go.mod` exists.
fn walk_up_for_backend_go_mod(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start.to_path_buf());
    while let Some(dir) = cur {
        if dir.join("backend").join("go.mod").is_file() {
            return Some(dir.join("backend"));
        }
        cur = dir.parent().map(Path::to_path_buf);
    }
    None
}

/// Locates the backend source tree to decide dev-vs-packaged: walks up from
/// `CARGO_MANIFEST_DIR` (debug builds only — it's a compile-time constant,
/// meaningless once installed elsewhere) and from the running executable's
/// directory.
pub fn detect_dev_backend_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
            if let Some(found) = walk_up_for_backend_go_mod(Path::new(&manifest_dir)) {
                return Some(found);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(found) = walk_up_for_backend_go_mod(parent) {
                return Some(found);
            }
        }
    }
    None
}

fn platform_is_windows() -> bool {
    cfg!(target_os = "windows")
}

async fn resolve_launch_for_app(app: &AppHandle, env: &HashMap<String, String>) -> Result<DaemonLaunchSpec, DaemonStatus> {
    let home_dir = dirs::home_dir().ok_or_else(|| DaemonStatus::error(failure_code::NOT_CONFIGURED, "Could not resolve the home directory."))?;

    let dev_backend_dir = detect_dev_backend_dir();
    let is_packaged = dev_backend_dir.is_none();

    let resources_path = app
        .path()
        .resolve("", BaseDirectory::Resource)
        .unwrap_or_default();
    let app_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();

    let mut spec = resolve_daemon_launch(
        env,
        is_packaged,
        &resources_path.to_string_lossy(),
        &app_path.to_string_lossy(),
        &home_dir.to_string_lossy(),
        platform_is_windows(),
    )
    .ok_or_else(|| DaemonStatus::error(failure_code::NOT_CONFIGURED, "Could not resolve the daemon launch command."))?;

    // Use the backend dir we actually found (rather than the TS's naive
    // `appPath/../backend` guess) as the dev cwd, per this task's explicit
    // go.mod walk-up requirement.
    if spec.source == LaunchSource::Dev {
        if let Some(dir) = dev_backend_dir {
            spec.cwd = dir.to_string_lossy().to_string();
        }
    }

    Ok(spec)
}

fn is_dev(spec: &DaemonLaunchSpec) -> bool {
    spec.source == LaunchSource::Dev
}

// ---------------------------------------------------------------------------
// Supervise-socket addressing — port of
// frontend/src/main.ts#supervisorPipeFromRunFile / establishSupervisorLink.
// ---------------------------------------------------------------------------

const DEFAULT_PIPE: &str = r"\\.\pipe\ao-supervise";

fn win_trim_trailing_slashes(s: &str) -> &str {
    s.trim_end_matches(['\\', '/'])
}

fn win_basename(path_str: &str) -> String {
    let s = win_trim_trailing_slashes(path_str);
    match s.rfind(['\\', '/']) {
        Some(idx) => s[idx + 1..].to_string(),
        None => s.to_string(),
    }
}

fn win_dirname(path_str: &str) -> String {
    let s = win_trim_trailing_slashes(path_str);
    match s.rfind(['\\', '/']) {
        Some(idx) => s[..idx].to_string(),
        None => String::new(),
    }
}

/// Port of `supervisorPipeFromRunFile`. Uses manual `\`/`/` parsing rather than
/// `std::path` so the Windows pipe-naming rule is unit-testable on any host —
/// `std::path` treats `\` as a plain character on non-Windows builds, which
/// would silently break this logic under `cargo test` on macOS/Linux CI.
pub fn supervisor_pipe_from_run_file(rfp: Option<&str>) -> String {
    let rfp = match rfp {
        Some(r) if !r.is_empty() => r,
        _ => return DEFAULT_PIPE.to_string(),
    };
    let dir = win_basename(&win_dirname(rfp));
    if dir == ".ao" || dir == "." || dir.is_empty() {
        return DEFAULT_PIPE.to_string();
    }
    let sanitized: String = dir
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    format!("{DEFAULT_PIPE}-{sanitized}")
}

/// Port of `establishSupervisorLink`'s address derivation: a unix socket next
/// to the run-file on unix, a named pipe derived from the run-file's parent
/// directory name on Windows.
pub fn supervisor_addr(run_file_path: Option<&str>, is_windows: bool) -> Option<String> {
    if is_windows {
        return Some(supervisor_pipe_from_run_file(run_file_path));
    }
    run_file_path.map(|rfp| {
        let dir = Path::new(rfp).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        format!("{dir}/supervise.sock")
    })
}

/// Port of `runFilePath()`: `AO_RUN_FILE` wins, then dev isolation
/// (`~/.ao/dev/running.json`), then the daemon's own default
/// (`~/.ao/running.json`) — matched against `defaultRunFilePath` in
/// frontend/src/shared/daemon-discovery.ts.
fn run_file_path(spec: &DaemonLaunchSpec, home_dir: &Path) -> Option<String> {
    if let Ok(v) = std::env::var("AO_RUN_FILE") {
        if !v.is_empty() {
            return Some(v);
        }
    }
    let home = home_dir.to_string_lossy();
    if is_dev(spec) {
        return Some(format!("{home}/.ao/dev/running.json"));
    }
    if home.is_empty() {
        return None;
    }
    Some(format!("{home}/.ao/running.json"))
}

async fn connect_supervisor(addr: &str) -> Option<SupervisorStream> {
    let name = addr.to_string().to_fs_name::<GenericFilePath>().ok()?;
    SupervisorStream::connect(name).await.ok()
}

// ---------------------------------------------------------------------------
// Daemon environment — port of frontend/src/shared/shell-env.ts +
// frontend/src/main.ts's daemonEnv().
// ---------------------------------------------------------------------------

const SHELL_ENV_TIMEOUT: Duration = Duration::from_secs(3);

async fn run_login_shell(shell_path: &str, args: &[String]) -> Result<Option<String>, String> {
    let mut cmd = Command::new(shell_path);
    cmd.args(args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    cmd.kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    match timeout(SHELL_ENV_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned())),
        Ok(Ok(_)) => Ok(None),
        Ok(Err(e)) => Err(e.to_string()),
        // Timed out: kill_on_drop(true) cleans up the still-running child when
        // the future (and its owned Child) is dropped here.
        Err(_) => Ok(None),
    }
}

async fn probe_shell_env() -> Option<HashMap<String, String>> {
    if platform_is_windows() {
        return None;
    }
    let runner: ShellRunner = Arc::new(|shell_path: String, args: Vec<String>| -> BoxFuture<'static, Result<Option<String>, String>> {
        Box::pin(async move { run_login_shell(&shell_path, &args).await })
    });
    let process_env: HashMap<String, String> = std::env::vars().collect();
    resolve_shell_env(&process_env, &runner).await
}

/// Port of `daemonEnv()`: dev isolation defaults (only when unset), the
/// per-launch `AO_APP_RUN_ID`, then (on unix) the shell-probed PATH/TERM via
/// `build_daemon_env`; Windows keeps the old behavior of no shell probe.
fn build_env_for_ensure(spec: &DaemonLaunchSpec, shell_env: Option<&HashMap<String, String>>, app_run_id: &str, home_dir: &Path) -> HashMap<String, String> {
    let process_env: HashMap<String, String> = std::env::vars().collect();

    let mut overrides: HashMap<String, String> = HashMap::new();
    overrides.insert("AO_APP_RUN_ID".to_string(), app_run_id.to_string());

    if is_dev(spec) {
        let home = home_dir.to_string_lossy();
        if !process_env.contains_key("AO_PORT") {
            overrides.insert("AO_PORT".to_string(), "3002".to_string());
        }
        if !process_env.contains_key("AO_RUN_FILE") {
            overrides.insert("AO_RUN_FILE".to_string(), format!("{home}/.ao/dev/running.json"));
        }
        if !process_env.contains_key("AO_DATA_DIR") {
            overrides.insert("AO_DATA_DIR".to_string(), format!("{home}/.ao/dev/data"));
        }
    }

    if platform_is_windows() {
        let mut merged = process_env;
        merged.extend(overrides);
        merged
    } else {
        build_daemon_env(&process_env, shell_env, &overrides)
    }
}

// ---------------------------------------------------------------------------
// `ao daemon ensure --owner app --json` invocation.
// ---------------------------------------------------------------------------

const ENSURE_TIMEOUT: Duration = Duration::from_secs(30);
const ENSURE_ARGS: [&str; 4] = ["ensure", "--owner", "app", "--json"];

#[derive(Debug, Deserialize)]
struct EnsureResult {
    port: u16,
    pid: u32,
    mode: String,
}

fn build_ensure_command(spec: &DaemonLaunchSpec) -> Command {
    if spec.shell {
        let mut full = spec.command.clone();
        for a in ENSURE_ARGS {
            full.push(' ');
            full.push_str(a);
        }
        if platform_is_windows() {
            let mut c = Command::new("cmd");
            c.args(["/C", &full]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", &full]);
            c
        }
    } else {
        let mut c = Command::new(&spec.command);
        c.args(&spec.args);
        c.args(ENSURE_ARGS);
        c
    }
}

async fn run_ensure(spec: &DaemonLaunchSpec, env: HashMap<String, String>) -> Result<EnsureResult, DaemonStatus> {
    let mut cmd = build_ensure_command(spec);
    cmd.current_dir(&spec.cwd);
    cmd.env_clear();
    cmd.envs(&env);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let child = cmd
        .spawn()
        .map_err(|e| DaemonStatus::error(failure_code::BINARY_MISSING, format!("Failed to launch the AO daemon ({}): {e}", spec.command)))?;

    let output = match timeout(ENSURE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(DaemonStatus::error(failure_code::SPAWN_FAILED, format!("ao daemon ensure failed: {e}"))),
        Err(_) => return Err(DaemonStatus::error(failure_code::DAEMON_UNREACHABLE, "ao daemon ensure timed out after 30s")),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(DaemonStatus {
            state: "error".to_string(),
            message: Some(format!("ao daemon ensure exited with {}", output.status)),
            details: Some(stderr),
            code: Some(failure_code::SPAWN_FAILED.to_string()),
            ..Default::default()
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    serde_json::from_str::<EnsureResult>(line).map_err(|e| DaemonStatus::error(failure_code::SPAWN_FAILED, format!("could not parse ensure output {line:?}: {e}")))
}

// ---------------------------------------------------------------------------
// Process-group backstop kill (no libc dependency available: Cargo.toml is
// frozen for this task, so this shells out to the OS's own kill tools rather
// than adding a dependency).
// ---------------------------------------------------------------------------

async fn terminate_process_group(pid: u32) {
    if platform_is_windows() {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status().await;
    } else {
        let _ = Command::new("kill").arg("-TERM").arg(format!("-{pid}")).status().await;
    }
}

/// Polls until the daemon's port stops accepting connections, or `budget`
/// elapses. Returns `true` once confirmed down, `false` if it timed out still
/// answering.
async fn wait_for_daemon_down(port: Option<u16>, budget: Duration) -> bool {
    let Some(port) = port else { return true };
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        let connected = matches!(
            tokio::time::timeout(Duration::from_millis(300), tokio::net::TcpStream::connect(("127.0.0.1", port))).await,
            Ok(Ok(_))
        );
        if !connected {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

// ---------------------------------------------------------------------------
// Managed state.
// ---------------------------------------------------------------------------

pub struct DaemonStateInner {
    pub status: DaemonStatus,
    pub app_run_id: String,
    pub spawned_pid: Option<u32>,
    pub link: Option<SupervisorStream>,
}

impl Default for DaemonStateInner {
    fn default() -> Self {
        // One id per app launch: pid + a monotonic timestamp is enough entropy
        // for a same-machine, single-process-lifetime identifier without
        // pulling in a uuid dependency (Cargo.toml is frozen for this task).
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        DaemonStateInner {
            status: DaemonStatus::stopped(),
            app_run_id: format!("apprun-{}-{nanos}", std::process::id()),
            spawned_pid: None,
            link: None,
        }
    }
}

pub struct DaemonState(pub Mutex<DaemonStateInner>);

impl Default for DaemonState {
    fn default() -> Self {
        DaemonState(Mutex::new(DaemonStateInner::default()))
    }
}

async fn set_status(state: &State<'_, DaemonState>, status: DaemonStatus) {
    let mut inner = state.0.lock().await;
    inner.status = status;
}

async fn emit_status(app: &AppHandle, status: &DaemonStatus) {
    let _ = app.emit("daemon://status", status);
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn daemon_get_status(state: State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    let status = state.0.lock().await.status.clone();
    serde_json::to_value(status).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn daemon_start(app: AppHandle, state: State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    let status = start_daemon(&app, &state).await;
    emit_status(&app, &status).await;
    serde_json::to_value(status).map_err(|e| e.to_string())
}

async fn start_daemon(app: &AppHandle, state: &State<'_, DaemonState>) -> DaemonStatus {
    let starting = DaemonStatus::starting();
    set_status(state, starting.clone()).await;
    emit_status(app, &starting).await;

    let env_map: HashMap<String, String> = std::env::vars().collect();
    let spec = match resolve_launch_for_app(app, &env_map).await {
        Ok(spec) => spec,
        Err(status) => {
            set_status(state, status.clone()).await;
            return status;
        }
    };

    let shell_env = probe_shell_env().await;
    let home_dir = dirs::home_dir().unwrap_or_default();
    let app_run_id = state.0.lock().await.app_run_id.clone();
    let env = build_env_for_ensure(&spec, shell_env.as_ref(), &app_run_id, &home_dir);

    let ensure_result = match run_ensure(&spec, env).await {
        Ok(r) => r,
        Err(status) => {
            set_status(state, status.clone()).await;
            return status;
        }
    };

    let status = DaemonStatus {
        state: "ready".to_string(),
        port: Some(ensure_result.port),
        pid: Some(ensure_result.pid),
        executable_path: Some(spec.command.clone()),
        working_directory: Some(spec.cwd.clone()),
        ..Default::default()
    };

    {
        let mut inner = state.0.lock().await;
        inner.status = status.clone();
        inner.spawned_pid = Some(ensure_result.pid);
    }

    // Only link when we actually spawned/took over the daemon — matches
    // daemon-owner.ts's `shouldLinkOnAttach`: a plain attach to an existing,
    // possibly not-app-owned daemon must not create a lifetime link.
    if ensure_result.mode == "spawned" || ensure_result.mode == "takeover" {
        let rfp = run_file_path(&spec, &home_dir);
        if let Some(addr) = supervisor_addr(rfp.as_deref(), platform_is_windows()) {
            if let Some(link) = connect_supervisor(&addr).await {
                state.0.lock().await.link = Some(link);
            }
        }
    }

    status
}

#[tauri::command]
pub async fn daemon_stop(app: AppHandle, state: State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    let (pid, port) = {
        let mut inner = state.0.lock().await;
        // Dropping the link closes the fd; the daemon detects EOF and
        // self-stops within its ~5s grace period.
        inner.link = None;
        (inner.spawned_pid.take(), inner.status.port)
    };

    if let Some(pid) = pid {
        terminate_process_group(pid).await;
    }

    wait_for_daemon_down(port, Duration::from_secs(5)).await;

    let status = DaemonStatus::stopped();
    set_status(&state, status.clone()).await;
    emit_status(&app, &status).await;
    serde_json::to_value(status).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn daemon_restart(app: AppHandle, state: State<'_, DaemonState>) -> Result<serde_json::Value, String> {
    daemon_stop(app.clone(), state.clone()).await?;
    daemon_start(app, state).await
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    mod resolve_daemon_launch_tests {
        use super::*;

        #[test]
        fn uses_ao_daemon_command_when_configured() {
            let spec = resolve_daemon_launch(&env(&[("AO_DAEMON_COMMAND", "/tmp/ao daemon")]), false, "/resources", "/app", "/home/user", false).unwrap();
            assert_eq!(
                spec,
                DaemonLaunchSpec {
                    command: "/tmp/ao daemon".to_string(),
                    args: vec![],
                    cwd: "/app".to_string(),
                    shell: true,
                    source: LaunchSource::Configured,
                }
            );
        }

        #[test]
        fn runs_the_backend_daemon_from_source_in_dev_without_an_explicit_command() {
            let spec = resolve_daemon_launch(&HashMap::new(), false, "/resources", "/repo/frontend", "/home/user", false).unwrap();
            assert_eq!(
                spec,
                DaemonLaunchSpec {
                    command: "go".to_string(),
                    args: vec!["run".to_string(), "./cmd/ao".to_string(), "daemon".to_string()],
                    cwd: "/repo/frontend/../backend".to_string(),
                    shell: false,
                    source: LaunchSource::Dev,
                }
            );
        }

        #[test]
        fn uses_the_bundled_daemon_binary_for_packaged_macos_linux_builds() {
            let spec = resolve_daemon_launch(&HashMap::new(), true, "/Applications/Agent Orchestrator.app/Contents/Resources", "/app", "/Users/alice", false).unwrap();
            assert_eq!(
                spec,
                DaemonLaunchSpec {
                    command: "/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao".to_string(),
                    args: vec!["daemon".to_string()],
                    cwd: "/Users/alice/.ao".to_string(),
                    shell: false,
                    source: LaunchSource::Bundled,
                }
            );
        }

        #[test]
        fn uses_the_bundled_daemon_exe_for_packaged_windows_builds() {
            let spec = resolve_daemon_launch(&HashMap::new(), true, "C:\\Program Files\\AO\\resources", "C:\\Program Files\\AO\\resources\\app.asar", "C:\\Users\\alice", true).unwrap();
            assert_eq!(
                spec,
                DaemonLaunchSpec {
                    command: "C:\\Program Files\\AO\\resources/daemon/ao.exe".to_string(),
                    args: vec!["daemon".to_string()],
                    cwd: "C:\\Users\\alice/.ao".to_string(),
                    shell: false,
                    source: LaunchSource::Bundled,
                }
            );
        }
    }

    mod supervisor_pipe_from_run_file_tests {
        use super::*;

        #[test]
        fn defaults_when_no_run_file_path() {
            assert_eq!(supervisor_pipe_from_run_file(None), DEFAULT_PIPE);
        }

        #[test]
        fn defaults_when_the_run_file_lives_directly_under_dot_ao() {
            assert_eq!(supervisor_pipe_from_run_file(Some("C:\\Users\\alice\\.ao\\running.json")), DEFAULT_PIPE);
        }

        #[test]
        fn defaults_when_the_parent_dir_is_the_current_dir_marker() {
            assert_eq!(supervisor_pipe_from_run_file(Some(".\\running.json")), DEFAULT_PIPE);
        }

        #[test]
        fn suffixes_with_the_isolating_subdir_name() {
            assert_eq!(
                supervisor_pipe_from_run_file(Some("C:\\Users\\alice\\.ao\\dev\\running.json")),
                format!("{DEFAULT_PIPE}-dev")
            );
        }

        #[test]
        fn sanitizes_non_alphanumeric_dash_characters_in_the_subdir_name() {
            assert_eq!(
                supervisor_pipe_from_run_file(Some("C:\\Users\\alice\\.ao\\my app!\\running.json")),
                format!("{DEFAULT_PIPE}-my-app-")
            );
        }

        #[test]
        fn defaults_for_an_empty_run_file_path() {
            assert_eq!(supervisor_pipe_from_run_file(Some("")), DEFAULT_PIPE);
        }
    }

    mod supervisor_addr_tests {
        use super::*;

        #[test]
        fn unix_joins_supervise_sock_next_to_the_run_file() {
            assert_eq!(
                supervisor_addr(Some("/Users/alice/.ao/dev/running.json"), false),
                Some("/Users/alice/.ao/dev/supervise.sock".to_string())
            );
        }

        #[test]
        fn unix_yields_none_without_a_run_file_path() {
            assert_eq!(supervisor_addr(None, false), None);
        }

        #[test]
        fn windows_delegates_to_pipe_derivation() {
            assert_eq!(
                supervisor_addr(Some("C:\\Users\\alice\\.ao\\dev\\running.json"), true),
                Some(format!("{DEFAULT_PIPE}-dev"))
            );
        }
    }

    mod daemon_status_serialization_tests {
        use super::*;

        #[test]
        fn field_names_match_the_ts_daemon_status_shape() {
            let status = DaemonStatus {
                state: "error".to_string(),
                port: Some(3001),
                pid: Some(1234),
                executable_path: Some("/usr/local/bin/ao".to_string()),
                working_directory: Some("/Users/alice/.ao".to_string()),
                message: Some("boom".to_string()),
                details: Some("stderr output".to_string()),
                code: Some(failure_code::SPAWN_FAILED.to_string()),
                exit_code: Some(1),
                signal: Some("SIGTERM".to_string()),
            };
            let value = serde_json::to_value(&status).unwrap();
            let obj = value.as_object().unwrap();
            let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
            keys.sort_unstable();
            let mut expected = vec![
                "state",
                "port",
                "pid",
                "executablePath",
                "workingDirectory",
                "message",
                "details",
                "code",
                "exitCode",
                "signal",
            ];
            expected.sort_unstable();
            assert_eq!(keys, expected);
        }

        #[test]
        fn stopped_default_only_serializes_state() {
            let value = serde_json::to_value(DaemonStatus::stopped()).unwrap();
            assert_eq!(value, serde_json::json!({ "state": "stopped" }));
        }
    }

    mod bundled_daemon_binary_name_tests {
        use super::*;

        #[test]
        fn windows_uses_exe_suffix() {
            assert_eq!(bundled_daemon_binary_name(true), "ao.exe");
        }

        #[test]
        fn unix_has_no_suffix() {
            assert_eq!(bundled_daemon_binary_name(false), "ao");
        }
    }
}
