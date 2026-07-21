import SwiftUI

// Start a new task: pick a project, dictate/type a prompt, spawn a worker.
struct SpawnView: View {
	@EnvironmentObject private var model: AppModel
	@Environment(\.dismiss) private var dismiss

	@State private var projects: [WireProject] = []
	@State private var selectedProjectId: String?
	@State private var prompt = ""
	@State private var isLoadingProjects = false
	@State private var isSpawning = false
	@State private var errorText: String?

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 10) {
				if isLoadingProjects {
					Text("Loading projects…")
						.font(.footnote)
						.foregroundStyle(.secondary)
				} else if projects.isEmpty {
					Text("No projects found.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				} else {
					Picker("Project", selection: $selectedProjectId) {
						ForEach(projects) { project in
							Text(project.title).tag(Optional(project.id))
						}
					}
				}

				TextField("Task prompt…", text: $prompt, axis: .vertical)
					.lineLimit(1 ... 5)

				Button {
					Task { await spawn() }
				} label: {
					Label(isSpawning ? "Spawning…" : "Spawn", systemImage: "sparkles")
						.frame(maxWidth: .infinity)
				}
				.buttonStyle(.borderedProminent)
				.disabled(isSpawning || selectedProjectId == nil || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

				if let errorText {
					Text(errorText)
						.font(.footnote)
						.foregroundStyle(.orange)
				}
			}
			.padding(.horizontal, 4)
		}
		.navigationTitle("New task")
		.task { await loadProjects() }
	}

	private func loadProjects() async {
		isLoadingProjects = true
		errorText = nil
		do {
			projects = try await model.client.listProjects()
			if selectedProjectId == nil { selectedProjectId = projects.first?.id }
		} catch {
			errorText = (error as? AOError)?.errorDescription ?? error.localizedDescription
		}
		isLoadingProjects = false
	}

	private func spawn() async {
		guard let projectId = selectedProjectId else { return }
		let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty else { return }
		isSpawning = true
		errorText = nil
		do {
			try await model.client.spawn(projectId: projectId, prompt: text)
			model.haptic(.success)
			dismiss()
		} catch {
			model.haptic(.failure)
			errorText = (error as? AOError)?.errorDescription ?? error.localizedDescription
		}
		isSpawning = false
	}
}
