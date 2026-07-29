// Git repository scanning for the "import folder" flow (project or workspace
// mode). Ported from frontend/src/main/import-folder-scan.ts +
// .test.ts — same git subcommands, same 5s per-call timeout, same JSON shape
// (ImportFolderScan / ImportRepoScan in frontend/src/shared/bridge-types.ts).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const SCAN_CONCURRENCY: usize = 8;
const SCAN_MAX_ENTRIES: usize = 200;

fn skip_dirs() -> HashSet<&'static str> {
    [".git", "node_modules", "dist", "build", ".cache", ".turbo", "target", "coverage", "tmp", "temp", "Library"]
        .into_iter()
        .collect()
}

#[derive(Debug, Clone, Default)]
pub struct ScanOptions {
    /// When set, replaces the git subprocess environment entirely (mirrors
    /// passing an explicit `env` to Node's execFile — `None` inherits the
    /// current process environment).
    pub env: Option<std::collections::HashMap<String, String>>,
    pub home_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoScanResult {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub branch: String,
    pub remote: String,
    pub has_remote: bool,
    pub status: String, // "ok" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFolderScanResult {
    pub path: String,
    pub repos: Vec<GitRepoScanResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_warning: Option<String>,
}

async fn git_output(cwd: &Path, args: &[&str], options: &ScanOptions) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    cmd.current_dir(cwd);
    if let Some(env) = &options.env {
        cmd.env_clear();
        cmd.envs(env);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let output = match timeout(GIT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err("git command timed out after 5s".to_string()),
    };
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn comparable_path(value: &str) -> String {
    let resolved = resolve_path(value);
    if cfg!(target_os = "windows") {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

/// Lightweight stand-in for Node's `path.resolve`: makes `value` absolute
/// against the current working directory (without requiring the path to
/// exist) and strips a trailing separator.
fn resolve_path(value: &str) -> String {
    let path = Path::new(value);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let s = absolute.to_string_lossy().to_string();
    let trimmed = s.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        s
    } else {
        trimmed.to_string()
    }
}

fn same_path(a: &str, b: &str) -> bool {
    comparable_path(a) == comparable_path(b)
}

fn normalize_git_reported_path(cwd: &Path, value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let p = Path::new(value);
    let resolved = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    resolved.to_string_lossy().to_string()
}

fn is_descendant_path(child: &str, parent: &str) -> bool {
    let child_key = comparable_path(child);
    let parent_key = comparable_path(parent);
    child_key == parent_key || child_key.starts_with(&format!("{parent_key}{}", std::path::MAIN_SEPARATOR))
}

fn project_setup_safety_reason(repo_path: &str, options: &ScanOptions) -> Option<String> {
    let home = options.home_dir.as_deref()?.trim();
    if home.is_empty() {
        return None;
    }
    let ao_state = Path::new(home).join(".ao");
    if is_descendant_path(repo_path, &ao_state.to_string_lossy()) {
        return Some("Selected folder is inside AO's internal data directory. Select a project folder outside ~/.ao.".to_string());
    }
    None
}

async fn ancestor_repository_setup_warning(repo_path: &Path, options: &ScanOptions) -> Option<String> {
    let raw_top = git_output(repo_path, &["rev-parse", "--show-toplevel"], options).await.ok()?;
    let top = normalize_git_reported_path(repo_path, &raw_top);
    let repo_path_str = repo_path.to_string_lossy().to_string();
    if !top.is_empty() && !same_path(&top, &repo_path_str) {
        return Some(format!(
            "Selected folder is inside an existing Git repository at {top}. AO will initialize this folder as a separate repository."
        ));
    }
    None
}

async fn is_git_repo(repo_path: &Path, options: &ScanOptions) -> bool {
    match std::fs::metadata(repo_path.join(".git")) {
        Ok(meta) if meta.is_dir() => {}
        _ => return false,
    }
    git_output(repo_path, &["rev-parse", "--show-toplevel"], options).await.is_ok()
}

async fn resolve_default_branch(repo_path: &Path, options: &ScanOptions) -> String {
    if let Ok(ref_name) = git_output(repo_path, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], options).await {
        if !ref_name.is_empty() {
            return ref_name.strip_prefix("origin/").unwrap_or(&ref_name).to_string();
        }
    }
    if let Ok(branch) = git_output(repo_path, &["branch", "--show-current"], options).await {
        if !branch.is_empty() {
            return branch;
        }
    }
    "HEAD".to_string()
}

fn scan_repo_validation_reason(name: &str, branch: &str, has_remote: bool, is_bare: bool, has_head: bool) -> Option<String> {
    if name == "__root__" {
        return Some("Repository name is reserved by AO.".to_string());
    }
    if is_bare {
        return Some("Bare repositories cannot be imported.".to_string());
    }
    if !has_head {
        return Some("Repository must have at least one commit.".to_string());
    }
    if branch == "HEAD" {
        return Some("Repository must have a checked-out branch.".to_string());
    }
    if !has_remote {
        return Some("Origin remote is required.".to_string());
    }
    None
}

fn relative_path_of(root: &Path, target: &Path) -> String {
    if target == root {
        return ".".to_string();
    }
    match target.strip_prefix(root) {
        Ok(rel) => rel.to_string_lossy().to_string(),
        Err(_) => target.to_string_lossy().to_string(),
    }
}

async fn scan_git_repo(repo_path: PathBuf, root_path: PathBuf, options: ScanOptions) -> Option<GitRepoScanResult> {
    let relative_path = relative_path_of(&root_path, &repo_path);
    let name = repo_path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let path_str = repo_path.to_string_lossy().to_string();

    match std::fs::metadata(repo_path.join(".git")) {
        Ok(meta) if meta.is_dir() => {
            // Falls through to the full scan below.
        }
        Ok(_) => {
            return Some(GitRepoScanResult {
                name,
                path: path_str,
                relative_path,
                branch: "HEAD".to_string(),
                remote: String::new(),
                has_remote: false,
                status: "error".to_string(),
                reason: Some("Linked worktree children cannot be imported.".to_string()),
            });
        }
        Err(_) => {
            if let Ok(v) = git_output(&repo_path, &["rev-parse", "--is-bare-repository"], &options).await {
                if v == "true" {
                    return Some(GitRepoScanResult {
                        name,
                        path: path_str,
                        relative_path,
                        branch: "HEAD".to_string(),
                        remote: String::new(),
                        has_remote: false,
                        status: "error".to_string(),
                        reason: Some("Bare repositories cannot be imported.".to_string()),
                    });
                }
            }
            return None;
        }
    }

    if !is_git_repo(&repo_path, &options).await {
        return None;
    }

    let (branch, remote_result, bare_result, head_result) = tokio::join!(
        resolve_default_branch(&repo_path, &options),
        git_output(&repo_path, &["remote", "get-url", "origin"], &options),
        git_output(&repo_path, &["rev-parse", "--is-bare-repository"], &options),
        git_output(&repo_path, &["rev-parse", "--verify", "HEAD"], &options),
    );

    let has_remote = remote_result.as_ref().map(|s| !s.is_empty()).unwrap_or(false);
    let remote = remote_result.unwrap_or_default();
    let is_bare = bare_result.as_deref() == Ok("true");
    let has_head = head_result.is_ok();

    let validation_reason = scan_repo_validation_reason(&name, &branch, has_remote, is_bare, has_head);
    let status = if validation_reason.is_some() { "error" } else { "ok" };

    Some(GitRepoScanResult {
        name,
        path: path_str,
        relative_path,
        branch,
        remote,
        has_remote,
        status: status.to_string(),
        reason: validation_reason,
    })
}

/// Runs up to `limit` futures concurrently, preserving input order in the
/// output. Hand-rolled (no `futures` crate dependency) using `tokio::sync::
/// Semaphore` + `JoinSet`, mirroring the TS `mapLimited` helper.
async fn map_limited<T, R, F, Fut>(items: Vec<T>, limit: usize, f: F) -> Vec<R>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Fut + Clone + Send + 'static,
    Fut: std::future::Future<Output = R> + Send + 'static,
{
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(limit.max(1)));
    let mut set = tokio::task::JoinSet::new();
    for (index, item) in items.into_iter().enumerate() {
        let sem = semaphore.clone();
        let f = f.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.expect("semaphore not closed");
            (index, f(item).await)
        });
    }
    let mut collected: Vec<(usize, R)> = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(pair) = res {
            collected.push(pair);
        }
    }
    collected.sort_by_key(|(index, _)| *index);
    collected.into_iter().map(|(_, r)| r).collect()
}

/// Port of `scanImportFolder`.
pub async fn scan_import_folder(root_path: PathBuf, mode: &str, options: ScanOptions) -> Result<ImportFolderScanResult, String> {
    let root_path_str = root_path.to_string_lossy().to_string();

    if mode == "project" {
        if let Some(safety_reason) = project_setup_safety_reason(&root_path_str, &options) {
            let name = root_path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            return Ok(ImportFolderScanResult {
                path: root_path_str.clone(),
                repos: vec![GitRepoScanResult {
                    name,
                    path: root_path_str,
                    relative_path: ".".to_string(),
                    branch: "HEAD".to_string(),
                    remote: String::new(),
                    has_remote: false,
                    status: "error".to_string(),
                    reason: Some(safety_reason),
                }],
                setup_warning: None,
            });
        }

        if let Some(repo) = scan_git_repo(root_path.clone(), root_path.clone(), options.clone()).await {
            return Ok(ImportFolderScanResult { path: root_path_str, repos: vec![repo], setup_warning: None });
        }

        let setup_warning = ancestor_repository_setup_warning(&root_path, &options).await;
        return Ok(ImportFolderScanResult { path: root_path_str, repos: vec![], setup_warning });
    }

    let skip = skip_dirs();
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&root_path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().map(|t| t.is_dir()).unwrap_or(false) && !skip.contains(e.file_name().to_string_lossy().as_ref())
        })
        .take(SCAN_MAX_ENTRIES)
        .collect();

    let root_for_task = root_path.clone();
    let opts_for_task = options.clone();
    let repos_opt: Vec<Option<GitRepoScanResult>> = map_limited(entries, SCAN_CONCURRENCY, move |entry| {
        let root = root_for_task.clone();
        let opts = opts_for_task.clone();
        async move { scan_git_repo(root.join(entry.file_name()), root, opts).await }
    })
    .await;

    let mut repos: Vec<GitRepoScanResult> = repos_opt.into_iter().flatten().collect();
    repos.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(ImportFolderScanResult { path: root_path_str, repos, setup_warning: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn tempdir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(args: &[&str], cwd: &Path) {
        let status = StdCommand::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "AO Test")
            .env("GIT_AUTHOR_EMAIL", "ao@example.com")
            .env("GIT_COMMITTER_NAME", "AO Test")
            .env("GIT_COMMITTER_EMAIL", "ao@example.com")
            .status()
            .expect("git must be installed to run these tests");
        assert!(status.success(), "git {args:?} failed in {cwd:?}");
    }

    fn committed_repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(&["init", "-b", "main", &dir.to_string_lossy()], dir.parent().unwrap());
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(&["add", "README.md"], dir);
        git(&["commit", "-m", "initial"], dir);
        git(&["remote", "add", "origin", "https://example.com/repo.git"], dir);
    }

    #[tokio::test]
    async fn leaves_a_plain_project_folder_nested_inside_a_parent_repo_setup_ready_with_a_warning() {
        let root = tempdir("ao-import-scan-nested");
        let parent = root.join("parent");
        committed_repo(&parent);
        let nested = parent.join("universe");
        std::fs::create_dir_all(&nested).unwrap();

        let scan = scan_import_folder(nested.clone(), "project", ScanOptions::default()).await.unwrap();

        assert_eq!(scan.path, nested.to_string_lossy());
        assert_eq!(scan.repos, vec![]);
        let warning = scan.setup_warning.expect("expected a setup warning");
        assert!(warning.contains("Selected folder is inside an existing Git repository at "));
        assert!(warning.contains("AO will initialize this folder as a separate repository."));
    }

    #[tokio::test]
    async fn reports_a_true_project_repository_root_as_importable() {
        let root = tempdir("ao-import-scan-root");
        let repo = root.join("repo");
        committed_repo(&repo);

        let scan = scan_import_folder(repo.clone(), "project", ScanOptions::default()).await.unwrap();

        assert_eq!(scan.repos.len(), 1);
        let result = &scan.repos[0];
        assert_eq!(result.name, "repo");
        assert_eq!(result.path, repo.to_string_lossy());
        assert_eq!(result.relative_path, ".");
        assert_eq!(result.branch, "main");
        assert!(result.has_remote);
        assert_eq!(result.status, "ok");
    }

    #[tokio::test]
    async fn leaves_a_plain_non_nested_project_folder_setup_ready() {
        let root = tempdir("ao-import-scan-plain");
        let selected = root.join("plain");
        std::fs::create_dir_all(&selected).unwrap();

        let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
        env.insert("GIT_CEILING_DIRECTORIES".to_string(), root.to_string_lossy().to_string());

        let scan = scan_import_folder(selected.clone(), "project", ScanOptions { env: Some(env), home_dir: None })
            .await
            .unwrap();

        assert_eq!(scan, ImportFolderScanResult { path: selected.to_string_lossy().to_string(), repos: vec![], setup_warning: None });
    }

    #[tokio::test]
    async fn reports_folders_inside_ao_managed_worktrees_before_offering_setup() {
        let home = tempdir("ao-import-scan-home");
        let selected = home.join(".ao").join("data").join("worktrees").join("project").join("session");
        std::fs::create_dir_all(&selected).unwrap();

        let scan = scan_import_folder(
            selected.clone(),
            "project",
            ScanOptions { env: None, home_dir: Some(home.to_string_lossy().to_string()) },
        )
        .await
        .unwrap();

        assert_eq!(scan.repos.len(), 1);
        let result = &scan.repos[0];
        assert_eq!(result.path, selected.to_string_lossy());
        assert_eq!(result.relative_path, ".");
        assert_eq!(result.status, "error");
        assert_eq!(
            result.reason.as_deref(),
            Some("Selected folder is inside AO's internal data directory. Select a project folder outside ~/.ao.")
        );
    }
}
