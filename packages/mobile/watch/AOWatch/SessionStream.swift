import Foundation

// Read-only view of a session's live output. Attaches to the daemon's /mux
// WebSocket as a SECONDARY terminal client (so it never changes the PTY size the
// desktop drives), decodes the base64 PTY stream, strips terminal control codes,
// and publishes a plain-text tail. Mirrors the resilient bits of
// packages/mobile/lib/mux.ts (auto-reconnect + keep-alive ping), which matter on
// the watch where the link (often relayed via the phone) is slow and flaky.
//
// The handshake (subscribe + terminal open) is sent from the delegate's
// didOpen callback, i.e. only once the socket is truly open — sending before the
// upgrade completed left the daemon with no "open" and thus no data on the watch.
@MainActor
final class SessionStream: NSObject, ObservableObject, URLSessionWebSocketDelegate {
	enum Status: Equatable {
		case idle, connecting, socketOpen, live, closed
		case error(String)
	}

	@Published private(set) var output = ""
	@Published private(set) var status: Status = .idle
	// Surfaced on-device so we can diagnose without a debugger.
	@Published private(set) var detail: String?
	@Published private(set) var attempts = 0

	private var config: AOConfig?
	private var sessionId = ""
	private var projectId: String?

	private var session: URLSession?
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
		session?.invalidateAndCancel()
		task = nil
		session = nil
		if status != .closed { status = .closed }
	}

	// MARK: - Reconnect loop

	private func runLoop() async {
		var backoffSeconds: UInt64 = 1
		while !stopped {
			let hadData = await connectAndReceive()
			if stopped { break }
			backoffSeconds = hadData ? 1 : min(backoffSeconds * 2, 15)
			if status != .closed { status = .connecting }
			try? await Task.sleep(nanoseconds: backoffSeconds * 1_000_000_000)
		}
	}

	private func connectAndReceive() async -> Bool {
		guard let config,
		      let base = config.baseURL,
		      var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)
		else { status = .error("Bad server address."); return false }
		comps.scheme = config.secure ? "wss" : "ws"
		comps.path = "/mux"
		guard let url = comps.url else { status = .error("Bad server address."); return false }

		var req = URLRequest(url: url)
		req.timeoutInterval = 30
		req.setValue("http://localhost", forHTTPHeaderField: "Origin")
		if !config.password.isEmpty {
			req.setValue("Bearer \(config.password)", forHTTPHeaderField: "Authorization")
		}

		let cfg = URLSessionConfiguration.ephemeral
		cfg.timeoutIntervalForRequest = 30
		// On the watch the WS path can be briefly "offline" (-1009) while the
		// relay/Wi-Fi settles; wait for a usable path instead of failing instantly.
		cfg.waitsForConnectivity = true
		cfg.timeoutIntervalForResource = 60
		let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
		let t = s.webSocketTask(with: req)
		session = s
		task = t
		attempts += 1
		if status != .live { status = .connecting }
		t.resume()

		var sawData = false
		while !stopped {
			do {
				let message = try await t.receive()
				if handle(message) { sawData = true }
			} catch {
				let ns = error as NSError
				detail = "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
				break
			}
		}
		pingTask?.cancel()
		s.invalidateAndCancel()
		return sawData
	}

	// MARK: - URLSessionWebSocketDelegate (called off the main actor)

	nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
	                            didOpenWithProtocol protocol: String?) {
		Task { @MainActor in self.onSocketOpen() }
	}

	nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
	                            didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
		let code = closeCode.rawValue
		let why = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
		Task { @MainActor in self.detail = "closed \(code)\(why.isEmpty ? "" : ": \(why)")" }
	}

	private func onSocketOpen() {
		if status == .connecting { status = .socketOpen }
		detail = "socket open; sent open, awaiting data"
		// Now that the upgrade completed, ask for session status + this terminal.
		sendJSON(["ch": "subscribe", "topics": ["sessions", "notifications"]])
		var open: [String: Any] = ["ch": "terminal", "id": sessionId, "type": "open", "role": "secondary"]
		if let projectId { open["projectId"] = projectId }
		sendJSON(open)
		startPing()
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
		detail = nil
		raw += chunk
		if raw.count > maxRawChars { raw = String(raw.suffix(maxRawChars)) }
		let cleaned = Self.sanitize(raw)
		output = cleaned.count > maxDisplayChars ? String(cleaned.suffix(maxDisplayChars)) : cleaned
	}

	// Strip ANSI/VT control sequences so a text-streaming agent reads cleanly.
	// Not a terminal emulator — full-screen TUI redraws will still look rough.
	static func sanitize(_ s: String) -> String {
		var t = s
		t = t.replacingOccurrences(of: "\u{1B}\\][^\u{07}\u{1B}]*(?:\u{07}|\u{1B}\\\\)", with: "", options: .regularExpression)
		t = t.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
		t = t.replacingOccurrences(of: "\u{1B}.", with: "", options: .regularExpression)
		t = t.replacingOccurrences(of: "\r\n", with: "\n")
		t = t.replacingOccurrences(of: "\r", with: "\n")
		t = t.replacingOccurrences(of: "[\u{00}-\u{08}\u{0B}-\u{1F}\u{7F}]", with: "", options: .regularExpression)
		return t
	}
}
