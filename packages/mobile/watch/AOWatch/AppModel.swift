import SwiftUI
import WatchKit

// App-wide state: the connection config (persisted) and a client built from it.
@MainActor
final class AppModel: ObservableObject {
	@Published var config: AOConfig {
		didSet { persist() }
	}

	private enum Keys {
		static let host = "ao.host"
		static let port = "ao.port"
		static let password = "ao.password"
		static let secure = "ao.secure"
	}

	init() {
		let d = UserDefaults.standard
		var loaded = AOConfig()
		loaded.host = d.string(forKey: Keys.host) ?? ""
		loaded.port = d.string(forKey: Keys.port) ?? "3011"
		loaded.password = d.string(forKey: Keys.password) ?? ""
		loaded.secure = d.bool(forKey: Keys.secure)
		// Property observers don't fire during init, so this load won't re-persist.
		self.config = loaded
	}

	var client: AOClient { AOClient(config: config) }

	private func persist() {
		let d = UserDefaults.standard
		d.set(config.host, forKey: Keys.host)
		d.set(config.port, forKey: Keys.port)
		d.set(config.password, forKey: Keys.password)
		d.set(config.secure, forKey: Keys.secure)
	}

	// Light haptic helpers so actions feel confirmed on the wrist.
	func haptic(_ type: WKHapticType) {
		WKInterfaceDevice.current().play(type)
	}
}
