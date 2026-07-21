import SwiftUI

// Connection setup: host / port / password for the daemon's LAN listener.
// watchOS text fields support dictation + Scribble, so entering these once is
// tolerable even without a keyboard.
struct ConnectView: View {
	@EnvironmentObject private var model: AppModel
	@Environment(\.dismiss) private var dismiss

	@State private var host = ""
	@State private var port = ""
	@State private var password = ""
	@State private var secure = false

	@State private var isTesting = false
	@State private var testResult: String?
	@State private var testOK = false

	var body: some View {
		Form {
			Section("Computer") {
				TextField("Host / IP", text: $host)
					.textContentType(.URL)
				TextField("Port", text: $port)
				TextField("Password", text: $password)
				Toggle("HTTPS", isOn: $secure)
			}

			Section {
				Button {
					Task { await test() }
				} label: {
					Label(isTesting ? "Testing…" : "Test connection", systemImage: "wifi")
				}
				.disabled(isTesting || host.trimmingCharacters(in: .whitespaces).isEmpty)

				if let testResult {
					Text(testResult)
						.font(.footnote)
						.foregroundStyle(testOK ? .green : .orange)
				}
			}

			Section {
				Button("Save") {
					save()
					dismiss()
				}
				.disabled(host.trimmingCharacters(in: .whitespaces).isEmpty)
			}
		}
		.navigationTitle("Connect")
		.onAppear(perform: seedFromModel)
	}

	private func seedFromModel() {
		host = model.config.host
		port = model.config.port.isEmpty ? "3011" : model.config.port
		password = model.config.password
		secure = model.config.secure
	}

	private func currentConfig() -> AOConfig {
		AOConfig(host: host, port: port, password: password, secure: secure)
	}

	private func save() {
		model.config = currentConfig()
	}

	private func test() async {
		isTesting = true
		testResult = nil
		let client = AOClient(config: currentConfig())
		do {
			try await client.ping()
			testOK = true
			testResult = "Connected."
			model.haptic(.success)
		} catch {
			testOK = false
			testResult = (error as? AOError)?.errorDescription ?? error.localizedDescription
			model.haptic(.failure)
		}
		isTesting = false
	}
}
