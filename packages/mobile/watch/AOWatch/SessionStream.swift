import Foundation

// Read-only view of a session's live output. Attaches to the daemon's /mux
// WebSocket as a SECONDARY terminal client (so it never changes the PTY size the
// desktop drives), decodes the base64 PTY stream, strips terminal control codes,
// and publishes a plain-text tail. Mirrors the resilient bits of
// packages/mobile/lib/mux.ts: auto-reconnect with backoff + keep-alive ping,
// which matters on the watch where the link (often relayed via the phone) is
// slower and flakier than a direct connection.
@MainActor
final class SessionStream: ObservableObject {
	enum Status: Equatable {
		case idle, connecting, live, closed
		case error(String)
	}

	@Published private(set) var output = ""
	@Published private(set) var status: Status = .idle

	private var config: AOConfig?
	private var sessionId = ""
	private var projectId: String?

	private var task: URLSessionWebSocketTask?
	private var pingTask: Task<Void, Never>?
	private var runLoopTask: Task<Void, Never>?
	private var stopped = false
	private var started = false
	private var raw = ""

	private let maxRawChars = 20_000
	private let maxDisplayChars = 6_000

	func start(config: AOConfig, sessionId: String, projectId: String?) {
		guard !started else { return }
		started = true
		self.config = config
		self.sessionId = sessionId
		self.projectId = projectId
		runLoopTask = Task { await self.runLoop() }
	}

	func stop() {
		stopped = true
		pingTask?.cancel()
		runLoopTask?.cancel()
		task?.cancel(with: .goingAway, reason: nil)
		task = nil
		if status != .closed { status = .closed }
	}

	// MARK: - Reconnect loop

	private func runLoop() async {
		var backoffSeconds: UInt64 = 1
		while !stopped {
			let hadData = await connectAndReceive()
			if stopped { break }
			// If we got output before dropping, reset backoff so a brief blip
			// reconnects fast; otherwise back off up to 15s.
			backoffSeconds = hadData ? 1 : min(backoffSeconds * 2, 15)
			if status != .closed { status = .connecting }
			try? await Task.sleep(nanoseconds: backoffSeconds * 1_000_000_000)
		}
	}

	/// Opens one socket and pumps it until it errors/closes. Returns whether any
	/// terminal data arrived on this attempt.
	private func connectAndReceive() async -> Bool {
		guard let config,
		      let base = config.baseURL,
		      var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)
		else {
			status = .error("Bad server address.")
			return false
		}
		comps.scheme = config.secure ? "wss" : "ws"
		comps.path = "/mux"
		guard let url = comps.url else {
			status = .error("Bad server address.")
			return false
		}

		var req = URLRequest(url: url)
		req.timeoutInterval = 30 // the watch link can be slow; don't bail early
		// The daemon 403s any non-loopback WS Origin before the upgrade; pin a
		// loopback Origin so the handshake passes (see lib/mux.ts).
		req.setValue("http://localhost", forHTTPHeaderField: "Origin")
		if !config.password.isEmpty {
			req.setValue("Bearer \(config.password)", forHTTPHeaderField: "Authorization")
		}

		let cfg = URLSessionConfiguration.ephemeral
		cfg.waitsForConnectivity = true
		cfg.timeoutIntervalForRequest = 30
		let session = URLSession(configuration: cfg)
		let t = session.webSocketTask(with: req)
		task = t
		if status != .live { status = .connecting }
		t.resume()

		sendJSON(["ch": "subscribe", "topics": ["sessions", "notifications"]])
		var open: [String: Any] = ["ch": "terminal", "id": sessionId, "type": "open", "role": "secondary"]
		if let projectId { open["projectId"] = projectId }
		sendJSON(open)
		startPing()

		var sawData = false
		while !stopped {
			do {
				let message = try await t.receive()
				if handle(message) { sawData = true }
			} catch {
				break
			}
		}
		pingTask?.cancel()
		return sawData
	}

	// MARK: - Internals

	private func startPing() {
		pingTask?.cancel()
		pingTask = Task { [weak self] in
			while !Task.isCancelled {
				try? await Task.sleep(nanoseconds: 20 * 1_000_000_000)
				await self?.sendJSON(["ch": "system", "type": "ping"])
			}
		}
	}

	private func sendJSON(_ obj: [String: Any]) {
		guard
			let data = try? JSONSerialization.data(withJSONObject: obj),
			let str = String(data: data, encoding: .utf8)
		else { return }
		task?.send(.string(str)) { _ in }
	}

	/// Returns true if this message carried terminal data.
	private func handle(_ message: URLSessionWebSocketTask.Message) -> Bool {
		guard
			case let .string(text) = message,
			let data = text.data(using: .utf8),
			let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else { return false }

		guard obj["ch"] as? String == "terminal", obj["id"] as? String == sessionId else { return false }

		switch obj["type"] as? String {
		case "data":
			if let b64 = obj["data"] as? String, let bytes = Data(base64Encoded: b64) {
				append(String(decoding: bytes, as: UTF8.self))
				return true
			}
		case "opened":
			if status != .live { status = .live }
		case "error":
			status = .error((obj["error"] as? String) ?? (obj["message"] as? String) ?? "Terminal error.")
		case "exited":
			status = .closed
		default:
			break
		}
		return false
	}

	private func append(_ chunk: String) {
		status = .live
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
