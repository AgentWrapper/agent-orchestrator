import AppKit
import Foundation

/// Per-project window position persistence. Keyed by projectId so each pet
/// remembers where it was last dragged to.
enum PositionStore {
    private static let prefix = "pet.position."
    private static let hiddenPrefix = "pet.hidden."

    static func save(_ point: NSPoint, for projectId: String) {
        let dict: [String: Double] = ["x": Double(point.x), "y": Double(point.y)]
        UserDefaults.standard.set(dict, forKey: prefix + projectId)
    }

    static func load(for projectId: String) -> NSPoint? {
        guard let dict = UserDefaults.standard.dictionary(forKey: prefix + projectId),
              let x = dict["x"] as? Double,
              let y = dict["y"] as? Double
        else { return nil }
        return NSPoint(x: x, y: y)
    }

    static func setHidden(_ hidden: Bool, for projectId: String) {
        UserDefaults.standard.set(hidden, forKey: hiddenPrefix + projectId)
    }

    static func isHidden(_ projectId: String) -> Bool {
        UserDefaults.standard.bool(forKey: hiddenPrefix + projectId)
    }
}
