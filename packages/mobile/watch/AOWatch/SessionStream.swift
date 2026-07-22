import Foundation

// Read-only view of a session's live output. Attaches to the daemon's /mux
// WebSocket as a SECONDARY terminal client (so it never changes the PTY size the
// desktop drives), decodes the base64 PTY stream, strips terminal control codes,
// and publishes a plain-text tail. Mirrors the bits of packages/mobile/lib/mux.ts
// that this watch POC needs.
@MainActor
final class SessionStream: ObservableObject {
	enum Status: Equatable {
		case idle, connecting, live, closed
		case error(String)
	}

	@Published private(set) var output = ""
	@Published private(set) var status: Status = .idle

	private var task: URLSessionWebSocketTask?
	private var session: URLSession?
	private var started = false
	private var raw = ""

	// Keep the raw buffer bounded (PTY streams are unbounded); display a shorter
	// tail so the watch stays responsive.
	private let maxRawChars = 20_000
	private let maxDisplayChars = 6_000

	func start(config: AOConfig, sessionId: String, projectId: String?) {
		guard !started else { return }
		started = true

		guard let base = config.baseURL,
		      var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)
		else {
			status = .error("Bad server address.")
			return
		}
		comps.scheme = config.secure ? "wss" : "ws"
		comps.path = "/mux"
		guard let url = comps.url else {
			status = .error("Bad server address.")
			return
		}

		var req = URLRequest(url: url)
		req.timeoutInterval = 15
		// The daemon 403s any non-loopback WS Origin before the upgrade; pin a
		// loopback Origin so the handshake passes (see lib/mux.ts).
		req.setValue("http://localhost", forHTTPHeaderField: "Origin")
		if !config.password.isEmpty {
			req.setValue("Bearer \(config.password)", forHTTPHeaderField: "Authorization")
		}

		let s = URLSession(configuration: .ephemeral)
		let t = s.webSocketTask(with: req)
		session = s
		task = t
		status = .connecting
		t.resume()

		// Subscribe to session status, then open this session's terminal as a
		// passive follower.
		sendJSON(["ch": "subscribe", "topics": ["sessions", "notifications"]])
		var open: [String: Any] = ["ch": "terminal", "id": sessionId, "type": "open", "role": "secondary"]
		if let projectId { open["projectId"] = projectId }
		sendJSON(open)

		let target = sessionId
		Task { await self.receiveLoop(sessionId: target) }
	}

	func stop() {
		task?.cancel(with: .goingAway, reason: nil)
		task = nil
		session = nil
		if status != .closed { status = .closed }
	}

	// MARK: - Internals

	private func sendJSON(_ obj: [String: Any]) {
		guard
			let data = try? JSONSerialization.data(withJSONObject: obj),
			let str = String(data: data, encoding: .utf8)
		else { return }
		task?.send(.string(str)) { _ in }
	}

	private func receiveLoop(sessionId: String) async {
		while let task {
			do {
				let message = try await task.receive()
				handle(message, sessionId: sessionId)
			} catch {
				if status != .closed { status = .error("Connection lost.") }
				return
			}
		}
	}

	private func handle(_ message: URLSessionWebSocketTask.Message, sessionId: String) {
		guard
			case let .string(text) = message,
			let data = text.data(using: .utf8),
			let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else { return }

		guard obj["ch"] as? String == "terminal", obj["id"] as? String == sessionId else { return }

		switch obj["type"] as? String {
		case "data":
			if let b64 = obj["data"] as? String, let bytes = Data(base64Encoded: b64) {
				append(String(decoding: bytes, as: UTF8.self))
			}
		case "opened":
			if status == .connecting { status = .live }
		case "error":
			status = .error((obj["error"] as? String) ?? (obj["message"] as? String) ?? "Terminal error.")
		case "exited":
			status = .closed
		default:
			break
		}
	}

	private func append(_ chunk: String) {
		if status == .connecting { status = .live }
		raw += chunk
		if raw.count > maxRawChars { raw = String(raw.suffix(maxRawChars)) }
		let cleaned = Self.sanitize(raw)
		output = cleaned.count > maxDisplayChars ? String(cleaned.suffix(maxDisplayChars)) : cleaned
	}

	// Strip ANSI/VT control sequences so a text-streaming agent reads cleanly.
	// Not a terminal emulator — full-screen TUI redraws will still look rough.
	static func sanitize(_ s: String) -> String {
		var t = s
		// OSC: ESC ] … (BEL | ESC \)
		t = t.replacingOccurrences(
			of: "\u{1B}\\][^\u{07}\u{1B}]*(?:\u{07}|\u{1B}\\\\)",
			with: "", options: .regularExpression)
		// CSI: ESC [ … final byte
		t = t.replacingOccurrences(
			of: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]",
			with: "", options: .regularExpression)
		// Any other two-char ESC sequence
		t = t.replacingOccurrences(of: "\u{1B}.", with: "", options: .regularExpression)
		// Normalize line endings
		t = t.replacingOccurrences(of: "\r\n", with: "\n")
		t = t.replacingOccurrences(of: "\r", with: "\n")
		// Drop remaining C0 control chars except newline and tab
		t = t.replacingOccurrences(
			of: "[\u{00}-\u{08}\u{0B}-\u{1F}\u{7F}]",
			with: "", options: .regularExpression)
		return t
	}
}
