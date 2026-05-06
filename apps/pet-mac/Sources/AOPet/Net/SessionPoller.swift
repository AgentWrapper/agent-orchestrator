import Foundation

/// Polls GET http://localhost:3001/api/sessions every `interval` seconds.
/// Posts the parsed response on `onUpdate` (called on the main queue).
final class SessionPoller {
    static let defaultInterval: TimeInterval = 5

    private let url: URL
    private let interval: TimeInterval
    private let session: URLSession
    private let onUpdate: (SessionsResponse) -> Void
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "dev.composio.aopet.poller")

    init(
        url: URL = URL(string: "http://localhost:3001/api/sessions")!,
        interval: TimeInterval = SessionPoller.defaultInterval,
        session: URLSession = .shared,
        onUpdate: @escaping (SessionsResponse) -> Void
    ) {
        self.url = url
        self.interval = interval
        self.session = session
        self.onUpdate = onUpdate
    }

    func start() {
        stop()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: interval)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    private func tick() {
        var req = URLRequest(url: url)
        req.timeoutInterval = max(2, interval - 1)
        let task = session.dataTask(with: req) { [weak self] data, response, error in
            guard let self = self else { return }
            if let error = error {
                OneShotLogger.shared.once("poll.network", "GET \(self.url) failed: \(error.localizedDescription)")
                return
            }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                OneShotLogger.shared.once("poll.status", "GET \(self.url) returned \(code)")
                return
            }
            guard let data = data else {
                OneShotLogger.shared.once("poll.empty", "GET \(self.url) returned empty body")
                return
            }
            do {
                let parsed = try WireDecoder.decodeSessions(data)
                OneShotLogger.shared.clear("poll.network")
                OneShotLogger.shared.clear("poll.status")
                OneShotLogger.shared.clear("poll.parse")
                DispatchQueue.main.async {
                    self.onUpdate(parsed)
                }
            } catch {
                OneShotLogger.shared.once("poll.parse", "Failed to decode /api/sessions: \(error)")
            }
        }
        task.resume()
    }
}
