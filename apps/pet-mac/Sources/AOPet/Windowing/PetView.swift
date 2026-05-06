import AppKit

/// The visible pet: sprite at the bottom, thought bubble at the top.
/// Forwards right-clicks to a delegate-provided NSMenu.
final class PetView: NSView {
    static let totalSize = NSSize(width: 160, height: 96)
    private static let spriteSize = NSSize(width: 64, height: 64)
    private static let bubbleHeight: CGFloat = 28

    private let imageView = NSImageView(frame: .zero)
    let bubble = ThoughtBubbleView(frame: .zero)

    /// Lazily provided by the controller — we ask for it on each right-click
    /// so menu items can reflect current state (project name, sprite name).
    var menuProvider: (() -> NSMenu?)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor

        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.frame = NSRect(
            x: bounds.width - PetView.spriteSize.width - 8,
            y: 4,
            width: PetView.spriteSize.width,
            height: PetView.spriteSize.height
        )
        imageView.autoresizingMask = [.minXMargin, .maxYMargin]
        addSubview(imageView)

        bubble.frame = NSRect(
            x: 4,
            y: bounds.height - PetView.bubbleHeight - 4,
            width: bounds.width - 8,
            height: PetView.bubbleHeight
        )
        bubble.autoresizingMask = [.maxXMargin, .minYMargin]
        bubble.isHidden = true
        addSubview(bubble)
    }

    func setImage(_ image: NSImage?) {
        imageView.image = image
    }

    func showBubble(text: String, tint: NSColor, durationSeconds: TimeInterval) {
        bubble.text = text
        bubble.tint = tint
        bubble.isHidden = false
        // Auto-hide after the duration unless replaced.
        bubble.layer?.removeAllAnimations()
        let token = UUID()
        bubbleToken = token
        DispatchQueue.main.asyncAfter(deadline: .now() + durationSeconds) { [weak self] in
            guard let self = self, self.bubbleToken == token else { return }
            self.bubble.isHidden = true
            self.bubble.text = nil
        }
    }
    private var bubbleToken: UUID?

    /// One-shot reaction overlay — vertical jump + brief tint flash.
    func playReaction(_ kind: ReactionKind) {
        let layer = imageView.layer ?? imageView.makeBackingLayer()
        imageView.wantsLayer = true
        imageView.layer = layer

        switch kind {
        case .flash:
            let anim = CABasicAnimation(keyPath: "opacity")
            anim.fromValue = 1.0
            anim.toValue = 0.4
            anim.duration = 0.12
            anim.autoreverses = true
            anim.repeatCount = 2
            layer.add(anim, forKey: "flash")
        case .jump:
            let anim = CABasicAnimation(keyPath: "transform.translation.y")
            // Quartz layer Y is inverted relative to NSView Y, but for a brief
            // bounce either direction reads as a "jump".
            anim.fromValue = 0
            anim.toValue = -8
            anim.duration = 0.18
            anim.autoreverses = true
            anim.repeatCount = 1
            layer.add(anim, forKey: "jump")
        case .shake:
            let anim = CAKeyframeAnimation(keyPath: "transform.translation.x")
            anim.values = [0, -4, 4, -3, 3, 0]
            anim.duration = 0.32
            layer.add(anim, forKey: "shake")
        case .bounce:
            let anim = CABasicAnimation(keyPath: "transform.scale")
            anim.fromValue = 1.0
            anim.toValue = 1.08
            anim.duration = 0.12
            anim.autoreverses = true
            anim.repeatCount = 1
            layer.add(anim, forKey: "bounce")
        }
    }

    enum ReactionKind {
        case flash, jump, shake, bounce

        static func forPriority(_ priority: EventPriority) -> ReactionKind {
            switch priority {
            case .urgent:  return .flash
            case .action:  return .jump
            case .warning: return .shake
            case .info, .unknown: return .bounce
            }
        }
    }

    // MARK: - Right-click menu

    override func menu(for event: NSEvent) -> NSMenu? {
        return menuProvider?() ?? nil
    }

    override func rightMouseDown(with event: NSEvent) {
        if let menu = menuProvider?() ?? nil {
            NSMenu.popUpContextMenu(menu, with: event, for: self)
        } else {
            super.rightMouseDown(with: event)
        }
    }
}
