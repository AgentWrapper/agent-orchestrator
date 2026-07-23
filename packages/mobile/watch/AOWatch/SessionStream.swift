import Foundation

// Live-ish view of a session's output by POLLING the daemon's REST snapshot
// endpoint (GET /sessions/{id}/output). watchOS blocks WebSockets entirely
// (both URLSessionWebSocketTask and NWConnection fail — see the diagnostics),
// while HTTP works reliably, so reading is done by refreshing on an interval.
// The server returns clean plain text (tmux capture-pane), so no ANSI stripping
// is needed here.
@MainActor
final class SessionStream: ObservableObject {
	enum Status: Equatable {
		case idle, loading, live, closed
		case error(String)
	}

	@Published private(set) var output = ""
	@Published private(set) var status: Status = .idle

	private var config: AOConfig?
	private var sessionId = ""
	private var pollTask: Task<Void, Never>?
	private var started = false

	private let interval: UInt64 = 2 * 1_000_000_000 // 2s

	func start(config: AOConfig, sessionId: String, projectId _: String?) {
		guard !started else { return }
		started = true
		self.config = config
		self.sessionId = sessionId
		pollTask = Task { await pollLoop() }
	}

	func stop() {
		pollTask?.cancel()
		pollTask = nil
		if status != .closed { status = .closed }
	}

	private func pollLoop() async {
		guard let config else { return }
		let client = AOClient(config: config)
		if status == .idle { status = .loading }
		while !Task.isCancelled {
			do {
				let text = try await client.getOutput(sessionId: sessionId, lines: 200)
				if !Task.isCancelled {
					output = text
					status = .live
				}
			} catch {
				if !Task.isCancelled {
					status = .error((error as? AOError)?.errorDescription ?? error.localizedDescription)
				}
			}
			try? await Task.sleep(nanoseconds: interval)
		}
	}
}
