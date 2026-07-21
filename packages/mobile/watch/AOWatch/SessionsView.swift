import SwiftUI

// Home screen: the list of live worker sessions. Tap one to send input; the
// toolbar offers a new-task spawn and the connection settings.
struct SessionsView: View {
	@EnvironmentObject private var model: AppModel

	@State private var sessions: [WireSession] = []
	@State private var isLoading = false
	@State private var errorText: String?

	var body: some View {
		Group {
			if !model.config.isConfigured {
				notConnected
			} else {
				list
			}
		}
		.navigationTitle("AO")
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				NavigationLink { SpawnView() } label: { Image(systemName: "plus") }
					.disabled(!model.config.isConfigured)
			}
			ToolbarItem(placement: .topBarLeading) {
				NavigationLink { ConnectView() } label: { Image(systemName: "gearshape") }
			}
		}
		.task { await load() }
	}

	private var notConnected: some View {
		VStack(spacing: 8) {
			Image(systemName: "antenna.radiowaves.left.and.right.slash")
				.font(.title3)
			Text("Not connected")
				.font(.headline)
			NavigationLink { ConnectView() } label: {
				Text("Set up connection")
			}
			.buttonStyle(.borderedProminent)
		}
		.padding()
	}

	private var list: some View {
		List {
			if let errorText {
				Text(errorText)
					.font(.footnote)
					.foregroundStyle(.orange)
			}

			if sessions.isEmpty, !isLoading, errorText == nil {
				Text("No live sessions.")
					.font(.footnote)
					.foregroundStyle(.secondary)
			}

			ForEach(sessions) { session in
				NavigationLink { SessionView(session: session) } label: {
					VStack(alignment: .leading, spacing: 2) {
						Text(session.title)
							.font(.headline)
							.lineLimit(1)
						if let sub = session.subtitle {
							Text(sub)
								.font(.caption2)
								.foregroundStyle(.secondary)
								.lineLimit(1)
						}
					}
				}
			}

			Button {
				Task { await load() }
			} label: {
				Label(isLoading ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
			}
			.disabled(isLoading)
		}
	}

	private func load() async {
		guard model.config.isConfigured else { return }
		isLoading = true
		errorText = nil
		do {
			sessions = try await model.client.listSessions()
		} catch {
			errorText = (error as? AOError)?.errorDescription ?? error.localizedDescription
		}
		isLoading = false
	}
}
