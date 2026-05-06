import AppKit
import Foundation

if CommandLine.arguments.contains("--self-test") {
    exit(SelfTest.run())
}

let app = NSApplication.shared
// Accessory: no Dock icon, no main menu bar takeover. The pet is the UI.
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
