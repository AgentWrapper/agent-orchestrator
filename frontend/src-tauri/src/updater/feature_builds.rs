// Port of frontend/src/main/feature-builds.ts (+ its test table).
//
// Feature builds are PR-scoped prerelease GitHub Releases carrying an
// `<!-- ao-feature-build: {...} -->` marker in their body. This module fetches
// and filters the live set (prerelease + marker + published within 7 days +
// PR still open), grouped to the newest build per PR, newest-first.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const GITHUB_API: &str = "https://api.github.com";

/// Feature builds older than this are dropped from the list, matching the
/// cleanup workflow's 7-day expiry sweep.
const MAX_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Marker embedded in feature-build release bodies by the CI workflow.
const FEATURE_BUILD_MARKER: &str = "<!-- ao-feature-build:";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureBuild {
    pub pr: i64,
    pub title: String,
    pub base: String,
    pub sha: String,
    pub slug: String,
    /// The version/tag of the build (e.g. "1.2.3-pr2270.0").
    pub build_id: String,
    pub published_at: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: String,
    prerelease: bool,
    published_at: String,
    body: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MarkerPayload {
    pr: i64,
    base: String,
    sha: String,
    slug: String,
}

#[derive(Debug, Deserialize)]
struct PrState {
    state: String,
}

/// Parse a version string for a feature-build prerelease identifier.
/// Matches "-pr<N>.<12-or-more-digit-ts>" (with optional leading "v").
/// Returns `Some(pr)` or `None`. Matches the TS regex
/// `/-pr(\d+)\.\d{12}/`, which is unanchored and therefore also matches
/// (and tolerates) longer digit runs, not just exactly 12.
pub fn parse_feature_build(version: &str) -> Option<i64> {
    let re_pos = version.find("-pr")?;
    let rest = &version[re_pos + 3..];
    let digits_end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    if digits_end == 0 {
        return None;
    }
    let pr_str = &rest[..digits_end];
    let after_pr = &rest[digits_end..];
    if !after_pr.starts_with('.') {
        return None;
    }
    let ts = &after_pr[1..];
    let ts_digits: String = ts.chars().take_while(|c| c.is_ascii_digit()).collect();
    if ts_digits.len() < 12 {
        return None;
    }
    let pr: i64 = pr_str.parse().ok()?;
    if pr > 0 {
        Some(pr)
    } else {
        None
    }
}

fn parse_marker(body: &str) -> Option<MarkerPayload> {
    let start = body.find(FEATURE_BUILD_MARKER)? + FEATURE_BUILD_MARKER.len();
    let end = body[start..].find("-->")? + start;
    serde_json::from_str::<MarkerPayload>(body[start..end].trim()).ok()
}

struct Candidate {
    build: FeatureBuild,
    published_ms: i64,
}

fn parse_published_ms(published_at: &str) -> i64 {
    // RFC3339 timestamps from the GitHub API; fall back to 0 (which sorts as
    // "very old" and gets filtered by the age cutoff) on any parse failure.
    chrono_parse_ms(published_at).unwrap_or(0)
}

// Minimal RFC3339 -> epoch-ms parser (avoids pulling in the `chrono` crate
// for a single field). GitHub always returns `YYYY-MM-DDTHH:MM:SSZ`.
fn chrono_parse_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, time) = s.split_once('T')?;
    let time = time.trim_end_matches('Z');
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: f64 = time_parts.next()?.parse().ok()?;

    // Days since epoch via a proleptic Gregorian calendar calculation.
    fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = (y - era * 400) as i64;
        let mp = (m + 9) % 12;
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86400 + hour * 3600 + minute * 60;
    Some(secs * 1000 + (second * 1000.0) as i64)
}

async fn fetch_json<T: for<'de> Deserialize<'de>>(client: &reqwest::Client, url: &str, user_agent: &str) -> Result<T, String> {
    let res = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", user_agent)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("GitHub API {}: {}", res.status(), url));
    }
    res.json::<T>().await.map_err(|e| e.to_string())
}

async fn is_pr_open(client: &reqwest::Client, api_base: &str, owner: &str, repo: &str, pr: i64, user_agent: &str) -> bool {
    let url = format!("{api_base}/repos/{owner}/{repo}/pulls/{pr}");
    match fetch_json::<PrState>(client, &url, user_agent).await {
        Ok(state) => state.state == "open",
        // On any error keep the entry rather than incorrectly filtering it out.
        Err(_) => true,
    }
}

/// Fetch and filter the live feature builds. THROWS (returns Err) on a
/// releases-fetch failure so callers can tell "no live builds" apart from
/// "could not reach GitHub".
pub async fn collect_feature_builds(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    user_agent: &str,
    now_ms: i64,
) -> Result<Vec<FeatureBuild>, String> {
    collect_feature_builds_from(client, GITHUB_API, owner, repo, user_agent, now_ms).await
}

async fn collect_feature_builds_from(
    client: &reqwest::Client,
    api_base: &str,
    owner: &str,
    repo: &str,
    user_agent: &str,
    now_ms: i64,
) -> Result<Vec<FeatureBuild>, String> {
    let url = format!("{api_base}/repos/{owner}/{repo}/releases?per_page=100");
    let releases = fetch_json::<Vec<GitHubRelease>>(client, &url, user_agent).await?;

    let cutoff = now_ms - MAX_AGE_MS;
    let mut candidates: Vec<Candidate> = Vec::new();
    for rel in releases {
        if !rel.prerelease {
            continue;
        }
        let published_ms = parse_published_ms(&rel.published_at);
        if published_ms < cutoff {
            continue;
        }
        let body = rel.body.unwrap_or_default();
        let Some(marker) = parse_marker(&body) else { continue };
        candidates.push(Candidate {
            build: FeatureBuild {
                pr: marker.pr,
                title: rel.name,
                base: marker.base,
                sha: marker.sha,
                slug: marker.slug,
                build_id: rel.tag_name,
                published_at: rel.published_at,
            },
            published_ms,
        });
    }

    if candidates.is_empty() {
        return Ok(vec![]);
    }

    let unique_prs: Vec<i64> = {
        let mut seen = std::collections::HashSet::new();
        candidates.iter().map(|c| c.build.pr).filter(|pr| seen.insert(*pr)).collect()
    };

    let mut open_map: HashMap<i64, bool> = HashMap::new();
    for pr in unique_prs {
        let open = is_pr_open(client, api_base, owner, repo, pr, user_agent).await;
        open_map.insert(pr, open);
    }

    let mut best_by_pr: HashMap<i64, Candidate> = HashMap::new();
    for c in candidates {
        if !*open_map.get(&c.build.pr).unwrap_or(&false) {
            continue;
        }
        match best_by_pr.get(&c.build.pr) {
            Some(existing) if existing.published_ms >= c.published_ms => {}
            _ => {
                best_by_pr.insert(c.build.pr, c);
            }
        }
    }

    let mut results: Vec<Candidate> = best_by_pr.into_values().collect();
    results.sort_by(|a, b| b.published_ms.cmp(&a.published_ms));

    Ok(results.into_iter().map(|c| c.build).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_feature_build_returns_pr_for_a_feature_build_version() {
        assert_eq!(parse_feature_build("0.2.0-pr2270.202607061200+abc1234"), Some(2270));
    }

    #[test]
    fn parse_feature_build_strips_a_leading_v() {
        assert_eq!(parse_feature_build("v0.2.0-pr2270.202607061200"), Some(2270));
    }

    #[test]
    fn parse_feature_build_returns_none_for_a_plain_stable_version() {
        assert_eq!(parse_feature_build("0.2.0"), None);
    }

    #[test]
    fn parse_feature_build_returns_none_for_a_nightly_version() {
        assert_eq!(parse_feature_build("0.3.0-nightly.202607060000"), None);
        assert_eq!(parse_feature_build("0.3.0-nightly.202607060000+abc1234"), None);
    }

    #[test]
    fn parse_feature_build_returns_none_for_an_empty_string() {
        assert_eq!(parse_feature_build(""), None);
    }

    #[test]
    fn parse_feature_build_accepts_more_than_12_digits() {
        // The TS regex `/-pr(\d+)\.\d{12}/` is unanchored, so a longer digit
        // run (e.g. an extra trailing digit before a build-metadata suffix)
        // still matches on the TS side; the Rust port must not be stricter.
        assert_eq!(parse_feature_build("0.2.0-pr2270.2026070612001"), Some(2270));
        assert_eq!(parse_feature_build("0.2.0-pr2270.2026070612001+abc1234"), Some(2270));
    }

    #[test]
    fn feature_build_serializes_camelcase_and_matches_bridge_types() {
        // Field names/casing must byte-match `FeatureBuild` in
        // frontend/src/shared/bridge-types.ts.
        let build = FeatureBuild {
            pr: 2270,
            title: "Feature build pr2270".to_string(),
            base: "main".to_string(),
            sha: "abc1234".to_string(),
            slug: "pr2270".to_string(),
            build_id: "v0.2.0-pr2270.202607061200".to_string(),
            published_at: "2026-07-06T12:00:00Z".to_string(),
        };
        let value = serde_json::to_value(&build).unwrap();
        assert_eq!(value["pr"], 2270);
        assert_eq!(value["title"], "Feature build pr2270");
        assert_eq!(value["base"], "main");
        assert_eq!(value["sha"], "abc1234");
        assert_eq!(value["slug"], "pr2270");
        assert_eq!(value["buildId"], "v0.2.0-pr2270.202607061200");
        assert_eq!(value["publishedAt"], "2026-07-06T12:00:00Z");
    }

    #[test]
    fn parse_marker_reads_the_ao_feature_build_comment() {
        let body = r#"<!-- ao-feature-build: {"pr":2270,"base":"main","sha":"abc1234","slug":"pr2270"} -->"#;
        let marker = parse_marker(body).expect("marker");
        assert_eq!(marker.pr, 2270);
        assert_eq!(marker.base, "main");
        assert_eq!(marker.sha, "abc1234");
        assert_eq!(marker.slug, "pr2270");
    }

    #[test]
    fn parse_marker_returns_none_for_malformed_json() {
        assert!(parse_marker("<!-- ao-feature-build: {bad json} -->").is_none());
    }

    #[test]
    fn parse_marker_returns_none_when_absent() {
        assert!(parse_marker("Just a normal release description.").is_none());
    }

    #[test]
    fn parse_published_ms_parses_rfc3339() {
        // 2026-07-06T12:00:00Z
        let ms = parse_published_ms("2026-07-06T12:00:00Z");
        assert!(ms > 0);
        // Sanity: one day later is exactly 86_400_000ms more.
        let ms2 = parse_published_ms("2026-07-07T12:00:00Z");
        assert_eq!(ms2 - ms, 86_400_000);
    }

    // -----------------------------------------------------------------------
    // collect_feature_builds behavioral table — ported from
    // frontend/src/main/feature-builds.test.ts's `listFeatureBuilds`
    // describe block, against a tiny hand-rolled mock HTTP server (this crate
    // has no HTTP mocking dev-dependency) instead of GitHub.
    // -----------------------------------------------------------------------

    use std::collections::HashMap as StdHashMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    const DEFAULT_MARKER: &str = r#"<!-- ao-feature-build: {"pr":2270,"base":"main","sha":"abc1234","slug":"pr2270"} -->"#;

    fn iso_ms_ago(ms_ago: i64) -> String {
        // Render an RFC3339 timestamp `ms_ago` milliseconds before "now" (test epoch).
        let now = now_epoch_ms();
        epoch_ms_to_iso(now - ms_ago)
    }

    fn now_epoch_ms() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
    }

    fn epoch_ms_to_iso(ms: i64) -> String {
        let secs = ms.div_euclid(1000);
        let days = secs.div_euclid(86400);
        let day_secs = secs.rem_euclid(86400);
        let (y, m, d) = civil_from_days(days);
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            y,
            m,
            d,
            day_secs / 3600,
            (day_secs % 3600) / 60,
            day_secs % 60
        )
    }

    fn civil_from_days(z: i64) -> (i64, i64, i64) {
        let z = z + 719468;
        let era = if z >= 0 { z } else { z - 146096 } / 146097;
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        (if m <= 2 { y + 1 } else { y }, m, d)
    }

    struct MockRelease {
        tag_name: &'static str,
        name: &'static str,
        prerelease: bool,
        published_at: String,
        body: Option<&'static str>,
    }

    fn make_release(published_at: String) -> MockRelease {
        MockRelease {
            tag_name: "v0.2.0-pr2270.202607061200",
            name: "Feature build pr2270",
            prerelease: true,
            published_at,
            body: Some(DEFAULT_MARKER),
        }
    }

    /// Spawn a mock GitHub API server: GET /repos/o/r/releases?... returns
    /// `releases_body`; GET /repos/o/r/pulls/<n> returns pr_states[n] (default
    /// `{"state":"open"}` when absent). Returns the base URL.
    async fn spawn_mock(releases_body: String, pr_states: StdHashMap<i64, &'static str>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let releases_body = releases_body.clone();
                let pr_states = pr_states.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = match stream.read(&mut buf).await {
                        Ok(n) => n,
                        Err(_) => return,
                    };
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("");
                    let body = if path.contains("/releases") {
                        releases_body
                    } else if let Some(pr_str) = path.rsplit('/').next() {
                        let pr: i64 = pr_str.parse().unwrap_or(-1);
                        let state = pr_states.get(&pr).copied().unwrap_or("open");
                        format!(r#"{{"state":"{state}"}}"#)
                    } else {
                        "{}".to_string()
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn release_json(rel: &MockRelease) -> serde_json::Value {
        json_release(rel.tag_name, rel.name, rel.prerelease, &rel.published_at, rel.body)
    }

    fn json_release(tag_name: &str, name: &str, prerelease: bool, published_at: &str, body: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "tag_name": tag_name,
            "name": name,
            "prerelease": prerelease,
            "published_at": published_at,
            "body": body,
        })
    }

    async fn collect_against(releases: Vec<serde_json::Value>, pr_states: StdHashMap<i64, &'static str>) -> Result<Vec<FeatureBuild>, String> {
        let base = spawn_mock(serde_json::to_string(&releases).unwrap(), pr_states).await;
        let client = reqwest::Client::new();
        collect_feature_builds_from(&client, &base, "owner", "repo", "ao-test", now_epoch_ms()).await
    }

    #[tokio::test]
    async fn excludes_non_prerelease_releases() {
        let mut rel = make_release(iso_ms_ago(DAY_MS));
        rel.prerelease = false;
        let result = collect_against(vec![release_json(&rel)], StdHashMap::new()).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn excludes_releases_with_no_marker() {
        let result = collect_against(
            vec![json_release(
                "v0.2.0-pr2270.202607061200",
                "Feature build pr2270",
                true,
                &iso_ms_ago(DAY_MS),
                Some("Just a normal release description."),
            )],
            StdHashMap::new(),
        )
        .await
        .unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn excludes_releases_with_a_null_body() {
        let result = collect_against(
            vec![json_release("v0.2.0-pr2270.202607061200", "Feature build pr2270", true, &iso_ms_ago(DAY_MS), None)],
            StdHashMap::new(),
        )
        .await
        .unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn excludes_releases_published_more_than_7_days_ago() {
        let mut states = StdHashMap::new();
        states.insert(2270, "open");
        let result = collect_against(vec![release_json(&make_release(iso_ms_ago(8 * DAY_MS)))], states).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn keeps_a_release_published_within_the_7_day_window() {
        let mut states = StdHashMap::new();
        states.insert(2270, "open");
        let result = collect_against(vec![release_json(&make_release(iso_ms_ago(6 * DAY_MS)))], states).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].pr, 2270);
    }

    #[tokio::test]
    async fn excludes_builds_whose_pr_is_closed() {
        let mut states = StdHashMap::new();
        states.insert(2270, "closed");
        let result = collect_against(vec![release_json(&make_release(iso_ms_ago(DAY_MS)))], states).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn excludes_builds_whose_pr_is_merged() {
        let mut states = StdHashMap::new();
        states.insert(2270, "merged");
        let result = collect_against(vec![release_json(&make_release(iso_ms_ago(DAY_MS)))], states).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn returns_a_feature_build_with_the_expected_shape_fields() {
        let mut states = StdHashMap::new();
        states.insert(2270, "open");
        let published_at = iso_ms_ago(DAY_MS);
        let result = collect_against(vec![release_json(&make_release(published_at.clone()))], states).await.unwrap();
        assert_eq!(result.len(), 1);
        let build = &result[0];
        assert_eq!(build.pr, 2270);
        assert_eq!(build.title, "Feature build pr2270");
        assert_eq!(build.base, "main");
        assert_eq!(build.sha, "abc1234");
        assert_eq!(build.slug, "pr2270");
        assert_eq!(build.build_id, "v0.2.0-pr2270.202607061200");
        assert_eq!(build.published_at, published_at);
    }

    #[tokio::test]
    async fn groups_multiple_builds_of_the_same_pr_keeping_only_the_newest() {
        let mut states = StdHashMap::new();
        states.insert(2270, "open");
        let older = iso_ms_ago(2 * DAY_MS);
        let newer = iso_ms_ago(DAY_MS);
        let result = collect_against(
            vec![
                json_release("v0.2.0-pr2270.202607050000", "Feature build pr2270 old", true, &older, Some(DEFAULT_MARKER)),
                json_release("v0.2.0-pr2270.202607061200", "Feature build pr2270 new", true, &newer, Some(DEFAULT_MARKER)),
            ],
            states,
        )
        .await
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].build_id, "v0.2.0-pr2270.202607061200");
        assert_eq!(result[0].title, "Feature build pr2270 new");
    }

    #[tokio::test]
    async fn sorts_results_newest_first_across_multiple_prs() {
        let mut states = StdHashMap::new();
        states.insert(2270, "open");
        states.insert(2271, "open");
        states.insert(2272, "open");
        let t1 = iso_ms_ago(3 * DAY_MS);
        let t2 = iso_ms_ago(DAY_MS);
        let t3 = iso_ms_ago(2 * DAY_MS);
        let result = collect_against(
            vec![
                json_release(
                    "v0.2.0-pr2271.202607040000",
                    "pr2271 build",
                    true,
                    &t1,
                    Some(r#"<!-- ao-feature-build: {"pr":2271,"base":"main","sha":"def5678","slug":"pr2271"} -->"#),
                ),
                json_release(
                    "v0.2.0-pr2272.202607060000",
                    "pr2272 build",
                    true,
                    &t2,
                    Some(r#"<!-- ao-feature-build: {"pr":2272,"base":"main","sha":"ghi9012","slug":"pr2272"} -->"#),
                ),
                json_release(
                    "v0.2.0-pr2270.202607050000",
                    "pr2270 build",
                    true,
                    &t3,
                    Some(r#"<!-- ao-feature-build: {"pr":2270,"base":"main","sha":"abc1234","slug":"pr2270"} -->"#),
                ),
            ],
            states,
        )
        .await
        .unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].pr, 2272);
        assert_eq!(result[1].pr, 2270);
        assert_eq!(result[2].pr, 2271);
    }
}
