import Foundation

// MARK: - Sessions API

/// Session status values surfaced by the AO dashboard.
/// Mirrors `SessionStatus` in packages/core/src/types.ts.
enum SessionStatus: String, Codable {
    case spawning, working, detecting
    case prOpen = "pr_open"
    case ciFailed = "ci_failed"
    case reviewPending = "review_pending"
    case changesRequested = "changes_requested"
    case approved, mergeable, merged, cleanup
    case needsInput = "needs_input"
    case stuck, errored, killed, idle, done, terminated
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionStatus(rawValue: raw) ?? .unknown
    }
}

enum ActivityState: String, Codable {
    case active, ready, idle
    case waitingInput = "waiting_input"
    case blocked, exited
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ActivityState(rawValue: raw) ?? .unknown
    }
}

/// Subset of DashboardSession we actually consume.
struct WireSession: Codable, Equatable {
    let id: String
    let projectId: String
    let status: SessionStatus
    let activity: ActivityState?
}

struct WireOrchestrator: Codable, Equatable {
    let id: String
    let projectId: String
    let projectName: String
}

/// Top-level shape of GET /api/sessions.
struct SessionsResponse: Codable, Equatable {
    let sessions: [WireSession]
    let orchestrators: [WireOrchestrator]?

    /// Build a {projectId: projectName} map from orchestrators.
    /// Falls back to projectId itself when no orchestrator surfaced a name.
    func projectNames() -> [String: String] {
        var map: [String: String] = [:]
        for orch in orchestrators ?? [] {
            map[orch.projectId] = orch.projectName
        }
        return map
    }
}

// MARK: - Socket Event

/// Notifier-pet pushes one of these per line.
/// Wire contract:
/// {"v":1,"kind":"event","event":{...},"actions":[...]}
struct SocketEnvelope: Codable, Equatable {
    let v: Int
    let kind: String
    let event: SocketEvent
    let actions: [SocketAction]?
}

enum EventPriority: String, Codable {
    case urgent, action, warning, info
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = EventPriority(rawValue: raw) ?? .unknown
    }
}

struct SocketEvent: Codable, Equatable {
    let id: String
    let type: String
    let priority: EventPriority
    let sessionId: String?
    let projectId: String?
    let timestamp: String?
    let message: String
}

struct SocketAction: Codable, Equatable {
    let label: String
    let action: String
}

// MARK: - Decoder helpers

enum WireDecoder {
    static let json: JSONDecoder = {
        let d = JSONDecoder()
        // Tolerate unknown keys; everything we care about is explicitly modeled.
        return d
    }()

    static func decodeSessions(_ data: Data) throws -> SessionsResponse {
        return try json.decode(SessionsResponse.self, from: data)
    }

    static func decodeEvent(_ line: Data) throws -> SocketEnvelope {
        return try json.decode(SocketEnvelope.self, from: line)
    }
}
