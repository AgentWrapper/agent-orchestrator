import Foundation
import Network

// Standalone connectivity probes for diagnosing why the mux WebSocket won't
// connect on the watch. Tests HTTP vs WebSocket against a public host and the
// daemon, so we can tell "WS never works over the relay" apart from "WS works
// but can't reach the private LAN IP".
enum NetDiag {
	/// Try to open a WebSocket and confirm it with a ping. Returns "OPEN ✓" or a
	/// short failure reason (domain/code/message).
	static func testWebSocket(_ urlString: String, origin: String?, bearer: String?, timeout: TimeInterval = 10) async -> String {
		guard let url = URL(string: urlString) else { return "bad url" }
		var req = URLRequest(url: url)
		req.timeoutInterval = timeout
		if let origin { req.setValue(origin, forHTTPHeaderField: "Origin") }
		if let bearer, !bearer.isEmpty { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }

		let session = URLSession(configuration: .ephemeral)
		let task = session.webSocketTask(with: req)
		task.resume()

		let result: String = await withCheckedContinuation { cont in
			let lock = NSLock()
			var finished = false
			func finish(_ s: String) {
				lock.lock(); defer { lock.unlock() }
				if !finished { finished = true; cont.resume(returning: s) }
			}
			// A ping only succeeds once the upgrade completed and the socket is open.
			task.sendPing { error in
				if let e = error as NSError? {
					finish("FAIL \(e.domain) \(e.code): \(e.localizedDescription)")
				} else {
					finish("OPEN ✓")
				}
			}
			DispatchQueue.global().asyncAfter(deadline: .now() + timeout + 2) {
				finish("TIMEOUT (>\(Int(timeout))s)")
			}
		}
		task.cancel(with: .goingAway, reason: nil)
		session.invalidateAndCancel()
		return result
	}

	/// Open a WebSocket using Network.framework (NWConnection) instead of
	/// URLSession. Reaching `.ready` means the WS upgrade succeeded. Some watchOS
	/// setups connect here where URLSessionWebSocketTask fails.
	static func testNWWebSocket(_ urlString: String, origin: String?, bearer: String?, timeout: TimeInterval = 10) async -> String {
		guard let url = URL(string: urlString), let scheme = url.scheme else { return "bad url" }

		let opts = NWProtocolWebSocket.Options()
		opts.autoReplyPing = true
		var headers: [(String, String)] = []
		if let origin { headers.append(("Origin", origin)) }
		if let bearer, !bearer.isEmpty { headers.append(("Authorization", "Bearer \(bearer)")) }
		if !headers.isEmpty { opts.setAdditionalHeaders(headers) }

		let params: NWParameters = (scheme == "wss") ? .tls : .tcp
		params.defaultProtocolStack.applicationProtocols.insert(opts, at: 0)

		let conn = NWConnection(to: .url(url), using: params)
		let result: String = await withCheckedContinuation { cont in
			let lock = NSLock()
			var finished = false
			func finish(_ s: String) {
				lock.lock(); defer { lock.unlock() }
				if !finished { finished = true; cont.resume(returning: s) }
			}
			conn.stateUpdateHandler = { state in
				switch state {
				case .ready:
					finish("OPEN ✓")
				case let .failed(err):
					finish("FAIL \(err.localizedDescription)")
				case let .waiting(err):
					finish("WAITING \(err.localizedDescription)")
				default:
					break
				}
			}
			conn.start(queue: .global())
			DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
				finish("TIMEOUT (>\(Int(timeout))s)")
			}
		}
		conn.cancel()
		return result
	}

	/// HTTP GET; returns "HTTP <code>" or a short failure reason.
	static func testHTTP(_ urlString: String, bearer: String?, timeout: TimeInterval = 10) async -> String {
		guard let url = URL(string: urlString) else { return "bad url" }
		var req = URLRequest(url: url)
		req.timeoutInterval = timeout
		if let bearer, !bearer.isEmpty { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }

		let cfg = URLSessionConfiguration.ephemeral
		cfg.timeoutIntervalForRequest = timeout
		let session = URLSession(configuration: cfg)
		defer { session.invalidateAndCancel() }
		do {
			let (_, resp) = try await session.data(for: req)
			let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
			return "HTTP \(code)"
		} catch {
			let e = error as NSError
			return "FAIL \(e.domain) \(e.code): \(e.localizedDescription)"
		}
	}
}
