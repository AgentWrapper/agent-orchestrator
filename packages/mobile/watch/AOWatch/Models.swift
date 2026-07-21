import Foundation

// Wire types mirror the AO daemon's /api/v1 responses (see
// packages/mobile/lib/api.ts). Only the fields the watch POC needs are decoded.

struct WireSession: Decodable, Identifiable, Sendable {
	let id: String
	let projectId: String?
	let kind: String?
	let displayName: String?
	let status: String?
	let isTerminated: Bool?
	let activity: Activity?

	var isWorker: Bool { kind != "orchestrator" }
	var isLive: Bool { !(isTerminated ?? false) }

	// A human label for the row: the display name, else a short id.
	var title: String {
		if let n = displayName, !n.isEmpty { return n }
		return String(id.prefix(8))
	}

	// A one-line subtitle from activity/status, whichever is present.
	var subtitle: String? {
		if let a = activity?.text, !a.isEmpty { return a }
		if let s = status, !s.isEmpty { return s }
		return nil
	}
}

// The daemon sends `activity` as either a plain string or an object { state }.
// Decode both shapes into a single optional string.
struct Activity: Decodable, Sendable {
	let text: String?

	init(from decoder: Decoder) throws {
		let container = try decoder.singleValueContainer()
		if let s = try? container.decode(String.self) {
			text = s
			return
		}
		struct Obj: Decodable { let state: String? }
		if let o = try? container.decode(Obj.self) {
			text = o.state
			return
		}
		text = nil
	}
}

struct SessionsResponse: Decodable, Sendable {
	let sessions: [WireSession]?
}

struct WireProject: Decodable, Identifiable, Sendable {
	let id: String
	let name: String?

	var title: String {
		if let n = name, !n.isEmpty { return n }
		return id
	}
}

struct ProjectsResponse: Decodable, Sendable {
	let projects: [WireProject]?
}

// The daemon's error envelope: { error, code, message, requestId }.
struct ErrorEnvelope: Decodable, Sendable {
	let error: String?
	let message: String?
}

enum AOError: LocalizedError {
	case notConfigured
	case http(status: Int, message: String?)
	case unreachable
	case decoding

	var errorDescription: String? {
		switch self {
		case .notConfigured:
			return "Set up the connection first."
		case let .http(status, message):
			if let m = message, !m.isEmpty { return m }
			return "Server error (\(status))."
		case .unreachable:
			return "Can't reach your computer. Is AO running and Connect Mobile on?"
		case .decoding:
			return "Unexpected response from AO."
		}
	}
}
