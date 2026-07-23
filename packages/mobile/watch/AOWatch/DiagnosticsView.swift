import SwiftUI

// Runs the 2×2 connectivity matrix (HTTP vs WebSocket, public vs daemon) on the
// watch so we can see exactly what the relay carries.
struct DiagnosticsView: View {
	@EnvironmentObject private var model: AppModel

	@State private var httpPublic = "—"
	@State private var httpDaemon = "—"
	@State private var wsPublic = "—"
	@State private var wsDaemon = "—"
	@State private var running = false

	private let publicHTTP = "https://captive.apple.com/hotspot-detect.html"
	private let publicWS = "wss://echo.websocket.events"

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 10) {
				row("HTTP → public", httpPublic)
				row("HTTP → daemon", httpDaemon)
				row("WS → public", wsPublic)
				row("WS → daemon", wsDaemon)

				Button {
					Task { await runAll() }
				} label: {
					Label(running ? "Running…" : "Run tests", systemImage: "stethoscope")
						.frame(maxWidth: .infinity)
				}
				.buttonStyle(.borderedProminent)
				.disabled(running)
			}
			.padding(.horizontal, 4)
		}
		.navigationTitle("Diagnostics")
	}

	private func row(_ title: String, _ value: String) -> some View {
		VStack(alignment: .leading, spacing: 1) {
			Text(title).font(.caption2).bold()
			Text(value)
				.font(.system(size: 11, design: .monospaced))
				.foregroundStyle(value.hasPrefix("OPEN") || value.hasPrefix("HTTP 2") ? .green
					: value == "—" || value.hasSuffix("…") ? .secondary : .orange)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
	}

	private func daemonWSURL() -> String? {
		guard let base = model.config.baseURL,
		      var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
		comps.scheme = model.config.secure ? "wss" : "ws"
		comps.path = "/mux"
		return comps.url?.absoluteString
	}

	private func daemonHTTPURL() -> String? {
		guard let base = model.config.baseURL else { return nil }
		return "\(base.absoluteString)/api/v1/sessions"
	}

	private func runAll() async {
		running = true
		httpPublic = "…"; httpDaemon = "…"; wsPublic = "…"; wsDaemon = "…"

		httpPublic = await NetDiag.testHTTP(publicHTTP, bearer: nil)
		if let u = daemonHTTPURL() {
			httpDaemon = await NetDiag.testHTTP(u, bearer: model.config.password)
		} else { httpDaemon = "no server set" }

		wsPublic = await NetDiag.testWebSocket(publicWS, origin: nil, bearer: nil)
		if let u = daemonWSURL() {
			wsDaemon = await NetDiag.testWebSocket(u, origin: "http://localhost", bearer: model.config.password)
		} else { wsDaemon = "no server set" }

		running = false
	}
}
