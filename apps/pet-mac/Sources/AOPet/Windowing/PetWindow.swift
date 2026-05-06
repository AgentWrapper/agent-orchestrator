import AppKit

/// Borderless, transparent, always-on-top NSWindow for a single project pet.
/// Click-through is OFF so the user can right-click for a context menu and
/// drag the pet around the screen.
final class PetWindow: NSWindow {
    static let defaultSize = NSSize(width: 96, height: 96)

    init(size: NSSize = PetWindow.defaultSize) {
        super.init(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .stationary]
        ignoresMouseEvents = false
        isMovableByWindowBackground = true
        // Don't deactivate the foreground app when the user drags the pet.
        // Borderless windows can't become key by default, but allow it anyway
        // so the right-click menu works.
        hidesOnDeactivate = false
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
