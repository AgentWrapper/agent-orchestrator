import SwiftUI

@main
struct AOWatchApp: App {
	@StateObject private var model = AppModel()

	var body: some Scene {
		WindowGroup {
			NavigationStack {
				SessionsView()
			}
			.environmentObject(model)
		}
	}
}
