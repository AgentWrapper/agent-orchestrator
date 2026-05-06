import Foundation

/// Visual mood the pet shows. Drives the idle animation.
/// Order in `priority(_:)` is the worst-state ranking — higher number wins.
enum PetMood: String, CaseIterable, Equatable {
    case sleeping       // all sessions idle/done — no work happening
    case happy          // PR ready (pr_open / approved / mergeable)
    case working        // someone is actively working / typing
    case sad            // ci_failed / stuck / blocked
    case alert          // waiting_input — needs human now
    case hidden         // no sessions for project

    /// Higher = more attention-needing. Used by the worst-state picker.
    var priority: Int {
        switch self {
        case .hidden:   return -1
        case .sleeping: return 0
        case .happy:    return 1
        case .working:  return 2
        case .sad:      return 3
        case .alert:    return 4
        }
    }
}

/// Group sessions by projectId and pick the most-attention mood per project.
enum StateAggregator {
    /// Map a single session to the mood it would induce on its own.
    /// Status takes priority over activity for the "alert/sad/happy" buckets;
    /// activity is the tiebreaker for "working" vs "sleeping".
    static func mood(for session: WireSession) -> PetMood {
        // 1. Waiting on a human — most urgent.
        if session.activity == .waitingInput || session.status == .needsInput {
            return .alert
        }

        // 2. Something is broken.
        switch session.status {
        case .ciFailed, .stuck, .errored, .changesRequested:
            return .sad
        default:
            break
        }
        if session.activity == .blocked {
            return .sad
        }

        // 3. PR is in a good place.
        switch session.status {
        case .prOpen, .approved, .mergeable:
            return .happy
        default:
            break
        }

        // 4. Something is actively running.
        if session.status == .working || session.status == .spawning ||
            session.status == .detecting || session.activity == .active {
            return .working
        }

        // 5. Done / merged / idle / unknown — sleep it off.
        return .sleeping
    }

    /// Per-project aggregated state: project name + worst mood + session count.
    struct ProjectState: Equatable {
        let projectId: String
        let projectName: String
        let mood: PetMood
        let sessionCount: Int
    }

    /// Aggregate the full sessions list into one ProjectState per project that
    /// has at least one session. Project names come from the orchestrator map;
    /// projects with no orchestrator fall back to their projectId.
    static func aggregate(
        sessions: [WireSession],
        projectNames: [String: String]
    ) -> [ProjectState] {
        var byProject: [String: [WireSession]] = [:]
        for s in sessions {
            byProject[s.projectId, default: []].append(s)
        }

        return byProject
            .map { projectId, group -> ProjectState in
                let worst = group
                    .map { mood(for: $0) }
                    .max(by: { $0.priority < $1.priority }) ?? .sleeping
                return ProjectState(
                    projectId: projectId,
                    projectName: projectNames[projectId] ?? projectId,
                    mood: worst,
                    sessionCount: group.count
                )
            }
            .sorted { $0.projectName < $1.projectName }
    }
}
