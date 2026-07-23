import Foundation

// Connection settings for the AO daemon's LAN listener. Persisted (non-secret
// fields + password) in UserDefaults — POC-grade; a production build would keep
// the password in the Keychain like the phone app does.
struct AOConfig: Equatable, Sendable {
	var host: String = ""
	var port: String = "3011"
	var password: String = ""
	var secure: Bool = false

	var cleanHost: String {
		host.trimmingCharacters(in: .whitespaces)
			.replacingOccurrences(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*://"#, with: "", options: .regularExpression)
			.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
	}

	var isConfigured: Bool { !cleanHost.isEmpty }

	var baseURL: URL? {
		let scheme = secure ? "https" : "http"
		let p = port.trimmingCharacters(in: .whitespaces)
		let portPart = p.isEmpty ? "" : ":\(p)"
		return URL(string: "\(scheme)://\(cleanHost)\(portPart)")
	}
}

// Talks to the AO daemon over HTTP with a bearer token. The single place that
// touches the network; every screen goes through it.
struct AOClient: Sendable {
	let config: AOConfig

	private static let apiPrefix = "/api/v1"

	private var session: URLSession {
		let cfg = URLSessionConfiguration.ephemeral
		// A sleeping/unreachable host must not hang the watch UI for the OS TCP
		// timeout; fail fast instead.
		cfg.timeoutIntervalForRequest = 12
		cfg.timeoutIntervalForResource = 12
		cfg.waitsForConnectivity = false
		return URLSession(configuration: cfg)
	}

	// MARK: Public API

	func listSessions() async throws -> [WireSession] {
		let data = try await request(path: "/sessions", method: "GET", body: nil)
		guard let decoded = try? JSONDecoder().decode(SessionsResponse.self, from: data) else {
			throw AOError.decoding
		}
		return (decoded.sessions ?? []).filter { $0.isWorker && $0.isLive }
	}

	func listProjects() async throws -> [WireProject] {
		let data = try await request(path: "/projects", method: "GET", body: nil)
		guard let decoded = try? JSONDecoder().decode(ProjectsResponse.self, from: data) else {
			throw AOError.decoding
		}
		return decoded.projects ?? []
	}

	/// Plain-text snapshot of a session's recent terminal output (tmux
	/// capture-pane server-side). Polled by the watch since watchOS can't hold
	/// the /mux WebSocket open.
	func getOutput(sessionId: String, lines: Int = 200) async throws -> String {
		let encodedId = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
		let data = try await request(path: "/sessions/\(encodedId)/output?lines=\(lines)", method: "GET", body: nil)
		guard let decoded = try? JSONDecoder().decode(OutputResponse.self, from: data) else {
			throw AOError.decoding
		}
		return decoded.output ?? ""
	}

	func send(sessionId: String, message: String) async throws {
		let encodedId = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
		let body = try JSONSerialization.data(withJSONObject: ["message": message])
		_ = try await request(path: "/sessions/\(encodedId)/send", method: "POST", body: body)
	}

	func spawn(projectId: String, prompt: String) async throws {
		let body = try JSONSerialization.data(withJSONObject: [
			"projectId": projectId,
			"prompt": prompt,
			"kind": "worker",
		])
		_ = try await request(path: "/sessions", method: "POST", body: body)
	}

	/// Reachability probe used by the Connect screen's "Test" button.
	func ping() async throws {
		_ = try await listSessions()
	}

	// MARK: Internal

	private func request(path: String, method: String, body: Data?) async throws -> Data {
		guard config.isConfigured, let base = config.baseURL else { throw AOError.notConfigured }
		guard let url = URL(string: "\(base.absoluteString)\(Self.apiPrefix)\(path)") else {
			throw AOError.notConfigured
		}

		var req = URLRequest(url: url)
		req.httpMethod = method
		req.httpBody = body
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		if !config.password.isEmpty {
			req.setValue("Bearer \(config.password)", forHTTPHeaderField: "Authorization")
		}

		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await session.data(for: req)
		} catch {
			throw AOError.unreachable
		}

		guard let http = response as? HTTPURLResponse else { throw AOError.decoding }
		guard (200 ..< 300).contains(http.statusCode) else {
			let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
			throw AOError.http(status: http.statusCode, message: envelope?.message ?? envelope?.error)
		}
		return data
	}
}
