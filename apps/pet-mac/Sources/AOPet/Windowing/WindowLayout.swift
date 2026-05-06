import AppKit

/// Auto-tiling helper. Lays out an ordered list of project windows starting
/// at the top-right of the main screen's visible frame and stepping down.
enum WindowLayout {
    static let margin: CGFloat = 16
    static let gap: CGFloat = 8

    /// Compute the origin for the Nth pet window in the tiling stack.
    /// Index 0 sits flush against the top-right corner, with subsequent
    /// windows stacked beneath it.
    static func origin(forIndex index: Int, size: NSSize, in screen: NSScreen) -> NSPoint {
        let frame = screen.visibleFrame
        let x = frame.maxX - margin - size.width
        let y = frame.maxY - margin - size.height - CGFloat(index) * (size.height + gap)
        return NSPoint(x: x, y: y)
    }
}
