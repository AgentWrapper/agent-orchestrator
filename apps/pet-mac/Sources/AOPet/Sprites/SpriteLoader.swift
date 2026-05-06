import AppKit
import Foundation

/// Loads frame sequences for a sprite set from the bundle.
/// Filenames are `{mood}_{frame}.png` under `Resources/sprites/{set}`.
struct SpriteSet: Equatable {
    let name: String
    /// frames[mood] is the ordered animation strip for that mood.
    private let frames: [PetMood: [NSImage]]

    init(name: String, frames: [PetMood: [NSImage]]) {
        self.name = name
        self.frames = frames
    }

    /// Number of frames available for `mood`. Always >= 1 once a set is loaded
    /// (loader inserts a placeholder if a mood has no PNG on disk).
    func frameCount(for mood: PetMood) -> Int {
        return max(frames[mood]?.count ?? 0, 1)
    }

    /// The image for `mood` at animation tick `tick` — wraps around so callers
    /// can pass a monotonic counter.
    func image(for mood: PetMood, tick: Int) -> NSImage? {
        guard let strip = frames[mood], !strip.isEmpty else { return nil }
        let idx = ((tick % strip.count) + strip.count) % strip.count
        return strip[idx]
    }
}

enum SpriteLoader {
    /// Names of sprite sets shipped in the bundle, in the order the
    /// "Switch sprite" menu cycles through them.
    static let availableSets: [String] = ["dog", "cat"]

    /// Load a sprite set by directory name (e.g. "dog"). Returns nil if the
    /// directory isn't in the bundle.
    static func load(_ setName: String, bundle: Bundle = .module) -> SpriteSet? {
        guard let baseURL = bundle.url(
            forResource: setName,
            withExtension: nil,
            subdirectory: "sprites"
        ) else {
            return nil
        }

        var frames: [PetMood: [NSImage]] = [:]
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(
            at: baseURL,
            includingPropertiesForKeys: nil
        ) else {
            return nil
        }

        // Group files by mood prefix, sort by frame index, load NSImages.
        var grouped: [PetMood: [(Int, URL)]] = [:]
        for url in contents where url.pathExtension.lowercased() == "png" {
            let stem = url.deletingPathExtension().lastPathComponent
            // Expected `mood_frame` — split on the LAST underscore so mood
            // names with underscores (none today, but cheap to support) work.
            guard let underscore = stem.lastIndex(of: "_"),
                  let frameIdx = Int(stem[stem.index(after: underscore)...]),
                  let mood = PetMood(rawValue: String(stem[stem.startIndex..<underscore]))
            else { continue }
            grouped[mood, default: []].append((frameIdx, url))
        }

        for (mood, list) in grouped {
            let sorted = list.sorted { $0.0 < $1.0 }
            frames[mood] = sorted.compactMap { NSImage(contentsOf: $0.1) }
        }

        return SpriteSet(name: setName, frames: frames)
    }
}
