// Recovering the login-shell environment so a Dock/Finder-style launch (started
// without a controlling terminal) gets the same PATH and exported credentials a
// terminal launch would. Ported from `frontend/src/shared/shell-env.ts` — kept
// pure (no process spawning in the parsing/merging helpers) so the logic here is
// unit-testable directly; the real shell spawn lives in `daemon::shell` and is
// injected via the `ShellRunner` type, mirroring the TS `ShellRunner` injection
// point.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub const SHELL_ENV_SENTINEL: &str = "__AO_SHELL_ENV__";

/// PATH floor: dirs a working macOS/Linux box keeps tools in, appended when the
/// shell probe fails so zellij/git/agents still resolve.
pub const FALLBACK_PATH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

/// Ask the login shell (-l sources zprofile via -i sourcing zshrc) to print a
/// sentinel then a NUL-separated env dump (-0 keeps values with newlines intact).
pub fn shell_env_args() -> Vec<String> {
    vec![
        "-ilc".to_string(),
        format!("printf '%s' '{SHELL_ENV_SENTINEL}'; env -0"),
    ]
}

/// Slice after the sentinel (drops banner/motd/prompt noise printed before it),
/// split on NUL, split each record on the first '='.
pub fn parse_env_block(stdout: &str) -> HashMap<String, String> {
    let block = match stdout.rfind(SHELL_ENV_SENTINEL) {
        Some(idx) => &stdout[idx + SHELL_ENV_SENTINEL.len()..],
        None => stdout,
    };
    let mut out = HashMap::new();
    for rec in block.split('\0') {
        if rec.is_empty() {
            continue;
        }
        match rec.find('=') {
            Some(0) | None => continue, // skip records with no key or a leading '='
            Some(eq) => {
                out.insert(rec[..eq].to_string(), rec[eq + 1..].to_string());
            }
        }
    }
    out
}

/// Prefer $SHELL (the user's login shell); under launchd it may be absent, so
/// fall back to /bin/zsh.
pub fn resolve_shell_path(env: &HashMap<String, String>) -> String {
    match env.get("SHELL").map(|s| s.trim()) {
        Some(shell) if !shell.is_empty() => shell.to_string(),
        _ => "/bin/zsh".to_string(),
    }
}

/// Append any missing floor dirs to PATH, preserving the existing order/priority
/// and de-duping.
pub fn with_fallback_path(current_path: Option<&str>) -> String {
    let mut result: Vec<String> = current_path
        .unwrap_or("")
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let mut present: std::collections::HashSet<String> = result.iter().cloned().collect();
    for dir in FALLBACK_PATH_DIRS {
        if !present.contains(*dir) {
            present.insert((*dir).to_string());
            result.push((*dir).to_string());
        }
    }
    result.join(":")
}

// TERM defaults to xterm-256color (what the renderer's xterm.js emulates): a
// Finder/Dock launch starts under launchd with no controlling tty, so TERM is
// unset, and the daemon's tmux attach client inherits that and dies with
// "open terminal failed: terminal does not support clear". A real TERM from the
// shell/process env still wins, except for the literal value "dumb".
fn normalize_term(term: Option<&str>) -> String {
    match term.map(|s| s.trim()) {
        Some(t) if !t.is_empty() && t != "dumb" => t.to_string(),
        _ => "xterm-256color".to_string(),
    }
}

/// Base = shell env, overlaid by process_env so the runtime env's own vars win,
/// then PATH forced to the shell's PATH (with floor), TERM normalized, then
/// explicit overrides win over everything.
pub fn build_daemon_env(
    process_env: &HashMap<String, String>,
    shell_env: Option<&HashMap<String, String>>,
    overrides: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut merged: HashMap<String, String> = HashMap::new();
    merged.insert("TERM".to_string(), "xterm-256color".to_string());
    if let Some(se) = shell_env {
        for (k, v) in se {
            merged.insert(k.clone(), v.clone());
        }
    }
    for (k, v) in process_env {
        merged.insert(k.clone(), v.clone());
    }
    let path_source = shell_env
        .and_then(|se| se.get("PATH"))
        .or_else(|| process_env.get("PATH"))
        .map(String::as_str);
    merged.insert("PATH".to_string(), with_fallback_path(path_source));
    let term = normalize_term(merged.get("TERM").map(String::as_str));
    merged.insert("TERM".to_string(), term);
    for (k, v) in overrides {
        merged.insert(k.clone(), v.clone());
    }
    merged
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Runs the probe shell and returns its captured stdout, `Ok(None)` on a clean
/// non-zero exit, or `Err` on a spawn failure / timeout. The real implementation
/// (in `daemon::shell`) spawns `shell_path` with `args` and enforces a 3s
/// timeout; this indirection keeps the parsing/merging logic above injectable
/// and unit-testable without spawning real processes.
pub type ShellRunner = Arc<dyn Fn(String, Vec<String>) -> BoxFuture<'static, Result<Option<String>, String>> + Send + Sync>;

/// Run the probe via an injected runner. Returns `None` on any failure/timeout
/// or if the result lacks PATH; the caller then falls back to the static floor.
pub async fn resolve_shell_env(
    env: &HashMap<String, String>,
    run: &ShellRunner,
) -> Option<HashMap<String, String>> {
    let shell_path = resolve_shell_path(env);
    let args = shell_env_args();
    match run(shell_path, args).await {
        Ok(Some(stdout)) => {
            let parsed = parse_env_block(&stdout);
            if parsed.contains_key("PATH") {
                Some(parsed)
            } else {
                None
            }
        }
        Ok(None) => None,
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    mod parse_env_block_tests {
        use super::*;

        #[test]
        fn parses_nul_separated_records_after_the_sentinel() {
            let stdout = format!("{SHELL_ENV_SENTINEL}PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/me\0");
            assert_eq!(
                parse_env_block(&stdout),
                map(&[("PATH", "/opt/homebrew/bin:/usr/bin"), ("HOME", "/Users/me")])
            );
        }

        #[test]
        fn drops_banner_prompt_noise_printed_before_the_sentinel() {
            let stdout = format!("motd line\nWelcome\n{SHELL_ENV_SENTINEL}FOO=bar\0");
            assert_eq!(parse_env_block(&stdout), map(&[("FOO", "bar")]));
        }

        #[test]
        fn preserves_a_value_containing_a_newline() {
            let stdout = format!("{SHELL_ENV_SENTINEL}MULTI=line1\nline2\0NEXT=ok\0");
            assert_eq!(parse_env_block(&stdout), map(&[("MULTI", "line1\nline2"), ("NEXT", "ok")]));
        }

        #[test]
        fn skips_records_with_no_equals_or_a_leading_equals() {
            let stdout = format!("{SHELL_ENV_SENTINEL}NOEQUALS\0=leading\0GOOD=value\0");
            assert_eq!(parse_env_block(&stdout), map(&[("GOOD", "value")]));
        }
    }

    mod with_fallback_path_tests {
        use super::*;

        #[test]
        fn appends_only_missing_floor_dirs_preserving_existing_order() {
            let result = with_fallback_path(Some("/opt/homebrew/bin:/custom/bin:/usr/bin"));
            assert_eq!(
                result,
                "/opt/homebrew/bin:/custom/bin:/usr/bin:/opt/homebrew/sbin:/usr/local/bin:/bin:/usr/sbin:/sbin"
            );
        }

        #[test]
        fn yields_the_full_floor_for_none_input() {
            assert_eq!(with_fallback_path(None), FALLBACK_PATH_DIRS.join(":"));
        }

        #[test]
        fn yields_the_full_floor_for_empty_input() {
            assert_eq!(with_fallback_path(Some("")), FALLBACK_PATH_DIRS.join(":"));
        }
    }

    mod build_daemon_env_tests {
        use super::*;

        #[test]
        fn overrides_win_over_both_shell_and_process_env() {
            let process_env = map(&[("PATH", "/usr/bin:/bin"), ("AO_TELEMETRY_EVENTS", "off")]);
            let shell_env = map(&[("PATH", "/opt/homebrew/bin"), ("AO_TELEMETRY_EVENTS", "shell")]);
            let overrides = map(&[("AO_TELEMETRY_EVENTS", "on")]);
            let env = build_daemon_env(&process_env, Some(&shell_env), &overrides);
            assert_eq!(env.get("AO_TELEMETRY_EVENTS").unwrap(), "on");
        }

        #[test]
        fn keeps_a_credential_present_only_in_the_shell_env() {
            let process_env = map(&[("PATH", "/usr/bin:/bin")]);
            let shell_env = map(&[("PATH", "/opt/homebrew/bin"), ("ANTHROPIC_API_KEY", "sk-ant")]);
            let env = build_daemon_env(&process_env, Some(&shell_env), &HashMap::new());
            assert_eq!(env.get("ANTHROPIC_API_KEY").unwrap(), "sk-ant");
        }

        #[test]
        fn takes_path_from_shell_env_with_floor_over_a_minimal_process_path() {
            let process_env = map(&[("PATH", "/usr/bin:/bin")]);
            let shell_env = map(&[("PATH", "/opt/homebrew/bin:/usr/bin")]);
            let env = build_daemon_env(&process_env, Some(&shell_env), &HashMap::new());
            assert_eq!(
                env.get("PATH").unwrap(),
                "/opt/homebrew/bin:/usr/bin:/opt/homebrew/sbin:/usr/local/bin:/bin:/usr/sbin:/sbin"
            );
        }

        #[test]
        fn still_produces_a_path_containing_the_floor_when_shell_env_is_none() {
            let process_env = map(&[("PATH", "/usr/bin:/bin")]);
            let env = build_daemon_env(&process_env, None, &HashMap::new());
            let path = env.get("PATH").unwrap();
            for dir in FALLBACK_PATH_DIRS {
                assert!(path.split(':').any(|p| p == *dir), "missing {dir} in {path}");
            }
        }

        #[test]
        fn defaults_term_when_neither_shell_nor_process_env_sets_it() {
            let process_env = map(&[("PATH", "/usr/bin:/bin")]);
            let env = build_daemon_env(&process_env, None, &HashMap::new());
            assert_eq!(env.get("TERM").unwrap(), "xterm-256color");
        }

        #[test]
        fn lets_a_real_term_from_the_process_env_win_over_the_default() {
            let process_env = map(&[("PATH", "/usr/bin:/bin"), ("TERM", "screen-256color")]);
            let env = build_daemon_env(&process_env, None, &HashMap::new());
            assert_eq!(env.get("TERM").unwrap(), "screen-256color");
        }

        #[test]
        fn replaces_term_dumb_because_tmux_attach_needs_clear_screen_support() {
            let process_env = map(&[("PATH", "/usr/bin:/bin"), ("TERM", "dumb")]);
            let env = build_daemon_env(&process_env, None, &HashMap::new());
            assert_eq!(env.get("TERM").unwrap(), "xterm-256color");
        }
    }

    mod resolve_shell_path_tests {
        use super::*;

        #[test]
        fn returns_shell_when_set() {
            assert_eq!(resolve_shell_path(&map(&[("SHELL", "/bin/bash")])), "/bin/bash");
        }

        #[test]
        fn falls_back_to_bin_zsh_when_unset() {
            assert_eq!(resolve_shell_path(&HashMap::new()), "/bin/zsh");
        }

        #[test]
        fn falls_back_to_bin_zsh_when_blank() {
            assert_eq!(resolve_shell_path(&map(&[("SHELL", "   ")])), "/bin/zsh");
        }
    }

    mod resolve_shell_env_tests {
        use super::*;

        fn runner_ok(stdout: &'static str) -> ShellRunner {
            Arc::new(move |_shell, _args| Box::pin(async move { Ok(Some(stdout.to_string())) }))
        }

        fn runner_none() -> ShellRunner {
            Arc::new(|_shell, _args| Box::pin(async move { Ok(None) }))
        }

        fn runner_err() -> ShellRunner {
            Arc::new(|_shell, _args| Box::pin(async move { Err("spawn failed".to_string()) }))
        }

        #[tokio::test]
        async fn yields_the_parsed_map_on_a_successful_probe() {
            let stdout: &'static str = Box::leak(format!("{SHELL_ENV_SENTINEL}PATH=/opt/homebrew/bin\0FOO=bar\0").into_boxed_str());
            let run = runner_ok(stdout);
            let env = map(&[("SHELL", "/bin/zsh")]);
            assert_eq!(
                resolve_shell_env(&env, &run).await,
                Some(map(&[("PATH", "/opt/homebrew/bin"), ("FOO", "bar")]))
            );
        }

        #[tokio::test]
        async fn returns_none_when_the_runner_returns_none() {
            let run = runner_none();
            assert_eq!(resolve_shell_env(&HashMap::new(), &run).await, None);
        }

        #[tokio::test]
        async fn returns_none_when_the_runner_errors() {
            let run = runner_err();
            assert_eq!(resolve_shell_env(&HashMap::new(), &run).await, None);
        }

        #[tokio::test]
        async fn returns_none_when_the_parsed_env_lacks_path() {
            let stdout: &'static str = Box::leak(format!("{SHELL_ENV_SENTINEL}FOO=bar\0").into_boxed_str());
            let run = runner_ok(stdout);
            assert_eq!(resolve_shell_env(&HashMap::new(), &run).await, None);
        }
    }
}
