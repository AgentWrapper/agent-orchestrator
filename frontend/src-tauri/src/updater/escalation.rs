// Port of frontend/src/main/escalation-evaluator.ts (+ its test table).
//
// Pure escalation decision: returns true when the user should be nudged
// harder to restart and install a downloaded update.
//
// "latest" channel: escalated after 48 hours of sitting staged.
// "nightly" channel: escalated when the feed marks the staged build
//   important, OR when the running version is behind the latest stable
//   release (time to jump to stable). The semver term is skipped when
//   latestStableVersion could not be fetched.

const H48_MS: i64 = 48 * 60 * 60 * 1000;

pub struct EscalationInput<'a> {
    pub channel: &'a str,
    pub staged_at: i64,
    pub now: i64,
    pub important: bool,
    pub running_version: &'a str,
    pub latest_stable_version: Option<&'a str>,
}

pub fn evaluate_escalation(input: EscalationInput<'_>) -> bool {
    let EscalationInput { channel, staged_at, now, important, running_version, latest_stable_version } = input;

    if channel == "latest" {
        return now - staged_at >= H48_MS;
    }

    // nightly channel
    if important {
        return true;
    }
    if let Some(latest_stable_version) = latest_stable_version {
        let running = match semver::Version::parse(running_version.trim_start_matches('v')) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let latest = match semver::Version::parse(latest_stable_version.trim_start_matches('v')) {
            Ok(v) => v,
            Err(_) => return false,
        };
        return running < latest;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const H48: i64 = 48 * 60 * 60 * 1000;

    fn now() -> i64 {
        1_800_000_000_000
    }

    #[test]
    fn latest_not_escalated_under_48h() {
        assert!(!evaluate_escalation(EscalationInput {
            channel: "latest",
            staged_at: now() - H48 + 1000,
            now: now(),
            important: false,
            running_version: "0.10.4",
            latest_stable_version: Some("0.10.5"),
        }));
    }

    #[test]
    fn latest_escalated_at_exactly_48h() {
        assert!(evaluate_escalation(EscalationInput {
            channel: "latest",
            staged_at: now() - H48,
            now: now(),
            important: false,
            running_version: "0.10.4",
            latest_stable_version: Some("0.10.5"),
        }));
    }

    #[test]
    fn latest_escalated_over_48h_even_without_stable_version_info() {
        assert!(evaluate_escalation(EscalationInput {
            channel: "latest",
            staged_at: now() - H48 - 1,
            now: now(),
            important: false,
            running_version: "0.10.4",
            latest_stable_version: None,
        }));
    }

    #[test]
    fn nightly_escalated_when_important_flag_is_set() {
        assert!(evaluate_escalation(EscalationInput {
            channel: "nightly",
            staged_at: now(),
            now: now(),
            important: true,
            running_version: "0.10.4-nightly.202607031330",
            latest_stable_version: None,
        }));
    }

    #[test]
    fn nightly_escalated_when_running_nightly_is_behind_stable_of_same_base() {
        assert!(evaluate_escalation(EscalationInput {
            channel: "nightly",
            staged_at: now(),
            now: now(),
            important: false,
            running_version: "0.10.4-nightly.202607031330",
            latest_stable_version: Some("0.10.4"),
        }));
    }

    #[test]
    fn nightly_not_escalated_when_nightly_is_ahead_of_stable() {
        assert!(!evaluate_escalation(EscalationInput {
            channel: "nightly",
            staged_at: now(),
            now: now(),
            important: false,
            running_version: "0.10.4-nightly.202607031330",
            latest_stable_version: Some("0.10.3"),
        }));
    }

    #[test]
    fn nightly_not_escalated_when_stable_version_info_is_missing() {
        assert!(!evaluate_escalation(EscalationInput {
            channel: "nightly",
            staged_at: now() - H48 * 10,
            now: now(),
            important: false,
            running_version: "0.10.4-nightly.202607031330",
            latest_stable_version: None,
        }));
    }

    #[test]
    fn nightly_not_escalated_on_unparseable_version_strings() {
        assert!(!evaluate_escalation(EscalationInput {
            channel: "nightly",
            staged_at: now(),
            now: now(),
            important: false,
            running_version: "not-a-version",
            latest_stable_version: Some("0.10.4"),
        }));
    }
}
