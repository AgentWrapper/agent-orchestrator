import AppKit

/// Owns one pet window for a single project. Updates sprite frame on a timer,
/// reacts to events with a one-shot animation + thought bubble, and provides
/// a right-click context menu.
final class PetController {
    let projectId: String
    private(set) var projectName: String
    private var mood: PetMood = .sleeping
    private var spriteSet: SpriteSet
    private let window: PetWindow
    private let view: PetView
    private var animationTimer: Timer?
    private var tick = 0
    /// Index in the layout stack — set by the WindowManager.
    var layoutIndex: Int = 0

    /// Called when the user picks "Switch sprite" — manager rotates which set
    /// every controller uses so all pets stay visually consistent.
    var onSwitchSprite: (() -> Void)?
    /// Called when the user picks "Hide" — manager removes the controller.
    var onHide: (() -> Void)?

    init(projectId: String, projectName: String, spriteSet: SpriteSet) {
        self.projectId = projectId
        self.projectName = projectName
        self.spriteSet = spriteSet
        self.window = PetWindow(size: PetView.totalSize)
        self.view = PetView(frame: NSRect(origin: .zero, size: PetView.totalSize))
        window.contentView = view

        view.menuProvider = { [weak self] in self?.buildMenu() }
        renderFrame()
        startAnimation()
    }

    // MARK: - Lifecycle

    func show(at fallbackOrigin: NSPoint) {
        let origin = PositionStore.load(for: projectId) ?? fallbackOrigin
        window.setFrameOrigin(origin)
        window.orderFrontRegardless()
        // Persist position whenever the user drags the window.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(didMove),
            name: NSWindow.didMoveNotification,
            object: window
        )
    }

    func close() {
        animationTimer?.invalidate()
        animationTimer = nil
        NotificationCenter.default.removeObserver(self)
        window.orderOut(nil)
    }

    @objc private func didMove() {
        PositionStore.save(window.frame.origin, for: projectId)
    }

    // MARK: - State updates

    func updateName(_ name: String) {
        projectName = name
    }

    func updateMood(_ newMood: PetMood) {
        guard newMood != mood else { return }
        mood = newMood
        tick = 0
        renderFrame()
    }

    func updateSpriteSet(_ set: SpriteSet) {
        spriteSet = set
        renderFrame()
    }

    /// Show an event reaction: bubble + one-shot animation.
    func handleEvent(_ event: SocketEvent) {
        let tint: NSColor
        switch event.priority {
        case .urgent:  tint = NSColor.systemRed
        case .warning: tint = NSColor.systemOrange
        case .action:  tint = NSColor.systemBlue
        case .info, .unknown: tint = NSColor(white: 0.2, alpha: 1)
        }
        let duration: TimeInterval = event.priority == .urgent ? 6 : 4
        view.showBubble(text: event.message, tint: tint, durationSeconds: duration)
        view.playReaction(PetView.ReactionKind.forPriority(event.priority))
    }

    // MARK: - Animation

    private func startAnimation() {
        let timer = Timer(timeInterval: 0.4, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.tick += 1
            self.renderFrame()
        }
        RunLoop.main.add(timer, forMode: .common)
        animationTimer = timer
    }

    private func renderFrame() {
        view.setImage(spriteSet.image(for: mood, tick: tick))
    }

    // MARK: - Menu

    private func buildMenu() -> NSMenu {
        let menu = NSMenu(title: "AOPet")

        let hideItem = NSMenuItem(
            title: "Hide \(projectName) pet",
            action: #selector(menuHide),
            keyEquivalent: ""
        )
        hideItem.target = self
        menu.addItem(hideItem)

        let switchItem = NSMenuItem(
            title: "Switch sprite",
            action: #selector(menuSwitchSprite),
            keyEquivalent: ""
        )
        switchItem.target = self
        menu.addItem(switchItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(
            title: "Quit AOPet",
            action: #selector(menuQuit),
            keyEquivalent: "q"
        )
        quitItem.target = self
        menu.addItem(quitItem)

        return menu
    }

    @objc private func menuHide() {
        PositionStore.setHidden(true, for: projectId)
        onHide?()
    }

    @objc private func menuSwitchSprite() {
        onSwitchSprite?()
    }

    @objc private func menuQuit() {
        NSApp.terminate(nil)
    }
}
