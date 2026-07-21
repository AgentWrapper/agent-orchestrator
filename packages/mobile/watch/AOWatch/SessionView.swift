import SwiftUI

// Send input to one session. The text field gives dictation/Scribble for free on
// watchOS, so "talk to your agent" is just tapping the field and speaking.
struct SessionView: View {
	@EnvironmentObject private var model: AppModel
	let session: WireSession

	@State private var message = ""
	@State private var isSending = false
	@State private var statusText: String?
	@State private var isError = false

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 10) {
				if let sub = session.subtitle {
					Text(sub)
						.font(.caption2)
						.foregroundStyle(.secondary)
				}

				TextField("Speak or type…", text: $message, axis: .vertical)
					.lineLimit(1 ... 4)

				Button {
					Task { await sendMessage() }
				} label: {
					Label(isSending ? "Sending…" : "Send", systemImage: "paperplane.fill")
						.frame(maxWidth: .infinity)
				}
				.buttonStyle(.borderedProminent)
				.disabled(isSending || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

				if let statusText {
					Text(statusText)
						.font(.footnote)
						.foregroundStyle(isError ? .orange : .green)
				}
			}
			.padding(.horizontal, 4)
		}
		.navigationTitle(session.title)
	}

	private func sendMessage() async {
		let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty else { return }
		isSending = true
		statusText = nil
		do {
			try await model.client.send(sessionId: session.id, message: text)
			model.haptic(.success)
			message = ""
			isError = false
			statusText = "Sent."
		} catch {
			model.haptic(.failure)
			isError = true
			statusText = (error as? AOError)?.errorDescription ?? error.localizedDescription
		}
		isSending = false
	}
}
