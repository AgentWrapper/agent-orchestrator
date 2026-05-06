import AppKit

/// Top-level coordinator: spins up one PetController per project, removes
/// controllers for projects that no longer have sessions, and routes socket
/// events to the right pet.
final class WindowManager {
    private var controllers: [String: PetController] = [:]
    private var orderedProjects: [String] = []
    private var currentSpriteName: String
    private var spriteSet: SpriteSet
    private static let defaultsKey = "pet.spriteSet"

    init() {
        let defaultsName = UserDefaults.standard.string(forKey: WindowManager.defaultsKey)
        let initial = defaultsName ?? SpriteLoader.availableSets.first ?? "dog"
        currentSpriteName = initial
        if let loaded = SpriteLoader.load(initial) {
            spriteSet = loaded
        } else if let fallback = SpriteLoader.availableSets.first.flatMap({ SpriteLoader.load($0) }) {
            spriteSet = fallback
            currentSpriteName = fallback.name
        } else {
            // Shouldn't happen — Resources/sprites always ships at least one
            // set — but provide an empty placeholder so the app still launches.
            spriteSet = SpriteSet(name: "empty", frames: [:])
        }
    }

    // MARK: - Reconcile

    /// Diff the current set of controllers against the latest project states
    /// and add / update / remove controllers to match.
    func reconcile(with projects: [StateAggregator.ProjectState]) {
        let visible = projects.filter { $0.mood != .hidden }
        let visibleIds = Set(visible.map { $0.projectId })

        for projectId in controllers.keys where !visibleIds.contains(projectId) {
            controllers.removeValue(forKey: projectId)?.close()
        }

        for project in visible {
            if PositionStore.isHidden(project.projectId) {
                controllers.removeValue(forKey: project.projectId)?.close()
                continue
            }
            if let existing = controllers[project.projectId] {
                existing.updateName(project.projectName)
                existing.updateMood(project.mood)
            } else {
                let controller = PetController(
                    projectId: project.projectId,
                    projectName: project.projectName,
                    spriteSet: spriteSet
                )
                controller.updateMood(project.mood)
                controller.onHide = { [weak self, weak controller] in
                    guard let self = self, let c = controller else { return }
                    self.controllers.removeValue(forKey: c.projectId)?.close()
                }
                controller.onSwitchSprite = { [weak self] in self?.cycleSprite() }
                controllers[project.projectId] = controller
            }
        }

        relayout(visibleProjects: visible)
    }

    private func relayout(visibleProjects: [StateAggregator.ProjectState]) {
        guard let screen = NSScreen.main else { return }
        // Stable ordering by projectName so windows don't jump around as
        // sessions come and go.
        let ordered = visibleProjects
            .map { $0.projectId }
            .filter { controllers[$0] != nil }
        orderedProjects = ordered
        for (idx, projectId) in ordered.enumerated() {
            guard let controller = controllers[projectId] else { continue }
            let fallback = WindowLayout.origin(
                forIndex: idx,
                size: PetView.totalSize,
                in: screen
            )
            controller.layoutIndex = idx
            controller.show(at: fallback)
        }
    }

    // MARK: - Event routing

    func deliver(event envelope: SocketEnvelope) {
        if let projectId = envelope.event.projectId,
           let controller = controllers[projectId] {
            controller.handleEvent(envelope.event)
            return
        }
        // No projectId, or no matching pet — broadcast so the user still
        // sees the event somewhere.
        for controller in controllers.values {
            controller.handleEvent(envelope.event)
        }
    }

    // MARK: - Sprite switching

    private func cycleSprite() {
        let sets = SpriteLoader.availableSets
        guard sets.count > 1, let currentIdx = sets.firstIndex(of: currentSpriteName) else {
            return
        }
        let nextName = sets[(currentIdx + 1) % sets.count]
        guard let next = SpriteLoader.load(nextName) else { return }
        currentSpriteName = nextName
        spriteSet = next
        UserDefaults.standard.set(nextName, forKey: WindowManager.defaultsKey)
        for controller in controllers.values {
            controller.updateSpriteSet(next)
        }
    }
}
