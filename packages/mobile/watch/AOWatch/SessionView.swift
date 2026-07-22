import SwiftUI

// Read + write one session: a live, scrolling tail of the agent's output, with a
// "Reply" action to send input (typed or dictated).
struct SessionView: View {
	@EnvironmentObject private var model: AppModel
	let session: WireSession

	@StateObject private var stream = SessionStream()
	@State private var showingReply = false

	var body: some View {
		ScrollViewReader { proxy in
			ScrollView {
				VStack(alignment: .leading, spacing: 6) {
					statusLine
					Text(stream.output.isEmpty ? "Waiting for output…" : stream.output)
						.font(.system(size: 13, design: .monospaced))
						.foregroundStyle(stream.output.isEmpty ? .secondary : .primary)
						.frame(maxWidth: .infinity, alignment: .leading)
					Color.clear.frame(height: 1).id("end")
				}
				.padding(.horizontal, 4)
			}
			.onChange(of: stream.output) { _, _ in
				proxy.scrollTo("end", anchor: .bottom)
			}
		}
		.navigationTitle(session.title)
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				Button { showingReply = true } label: {
					Image(systemName: "arrowshape.turn.up.left.fill")
				}
			}
		}
		.sheet(isPresented: $showingReply) {
			ReplySheet(sessionId: session.id)
				.environmentObject(model)
		}
		.task {
			stream.start(config: model.config, sessionId: session.id, projectId: session.projectId)
		}
		.onDisappear { stream.stop() }
	}

	@ViewBuilder private var statusLine: some View {
		switch stream.status {
		case .idle, .connecting:
			Label("Connecting…", systemImage: "dot.radiowaves.left.and.right")
				.font(.caption2).foregroundStyle(.secondary)
		case .live:
			Label("Live", systemImage: "dot.radiowaves.left.and.right")
				.font(.caption2).foregroundStyle(.green)
		case .closed:
			Label("Ended", systemImage: "stop.circle")
				.font(.caption2).foregroundStyle(.secondary)
		case let .error(message):
			Label(message, systemImage: "exclamationmark.triangle")
				.font(.caption2).foregroundStyle(.orange)
		}
	}
}

// Dictate or type a reply and send it to the session.
private struct ReplySheet: View {
	@EnvironmentObject private var model: AppModel
	@Environment(\.dismiss) private var dismiss
	let sessionId: String

	@State private var message = ""
	@State private var isSending = false
	@State private var errorText: String?

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 10) {
				TextField("Speak or type…", text: $message, axis: .vertical)
					.lineLimit(1 ... 5)

				Button {
					Task { await send() }
				} label: {
					Label(isSending ? "Sending…" : "Send", systemImage: "paperplane.fill")
						.frame(maxWidth: .infinity)
				}
				.buttonStyle(.borderedProminent)
				.disabled(isSending || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

				if let errorText {
					Text(errorText).font(.footnote).foregroundStyle(.orange)
				}
			}
			.padding(.horizontal, 4)
		}
		.navigationTitle("Reply")
	}

	private func send() async {
		let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty else { return }
		isSending = true
		errorText = nil
		do {
			try await model.client.send(sessionId: sessionId, message: text)
			model.haptic(.success)
			dismiss()
		} catch {
			model.haptic(.failure)
			errorText = (error as? AOError)?.errorDescription ?? error.localizedDescription
		}
		isSending = false
	}
}
