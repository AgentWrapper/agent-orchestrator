import Foundation
import os

/// Logs each unique error tag exactly once per process. Keeps the console quiet
/// when the dashboard or socket is down for an extended period.
final class OneShotLogger {
    static let shared = OneShotLogger()
    private let log = Logger(subsystem: "dev.composio.aopet", category: "net")
    private var seen = Set<String>()
    private let lock = NSLock()

    func once(_ tag: String, _ message: @autoclosure () -> String) {
        lock.lock()
        let isNew = seen.insert(tag).inserted
        lock.unlock()
        guard isNew else { return }
        let rendered = message()
        log.error("[\(tag, privacy: .public)] \(rendered, privacy: .public)")
    }

    /// Reset a tag so the next failure logs again — call on recovery so we
    /// notice when something flaps.
    func clear(_ tag: String) {
        lock.lock()
        seen.remove(tag)
        lock.unlock()
    }
}
