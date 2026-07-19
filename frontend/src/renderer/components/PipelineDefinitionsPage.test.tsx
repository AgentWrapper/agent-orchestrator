import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineDefinitionsPage } from "./PipelineDefinitionsPage";

const { getMock, postMock, putMock, deleteMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
	putMock: vi.fn(),
	deleteMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: (...args: unknown[]) => getMock(...args),
		POST: (...args: unknown[]) => postMock(...args),
		PUT: (...args: unknown[]) => putMock(...args),
		DELETE: (...args: unknown[]) => deleteMock(...args),
	},
	apiErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "error"),
}));

// CodeMirror needs a real layout engine jsdom lacks; swap it for a textarea so
// the CRUD/validation/sync flow is what's under test, not the editor internals.
// revealLine is exposed as a data attribute so the scroll wiring is assertable.
vi.mock("./YamlEditor", () => ({
	YamlEditor: ({
		value,
		onChange,
		revealLine,
	}: {
		value: string;
		onChange: (v: string) => void;
		revealLine?: number | null;
	}) => (
		<textarea
			aria-label="Pipeline YAML"
			data-reveal-line={revealLine ?? ""}
			value={value}
			onChange={(e) => onChange(e.target.value)}
		/>
	),
}));

// React Flow needs ResizeObserver + real layout jsdom lacks; stub the canvas
// with hooks that expose what the shell passes in (draft, selection, issue
// badges) and drive draft edits / node selection like real canvas gestures.
vi.mock("./PipelineCanvas", () => ({
	PipelineCanvas: ({
		draft,
		onDraftChange,
		selection,
		stageIssues,
	}: {
		draft: { stages: { name: string }[] };
		onDraftChange?: (next: unknown) => void;
		selection?: { selectedStage: string | null; selectStage: (name: string | null) => void };
		stageIssues?: Record<string, string[]>;
	}) => (
		<div data-testid="pipeline-canvas">
			<span data-testid="canvas-stages">{draft.stages.map((s) => s.name).join(",")}</span>
			<span data-testid="canvas-selected">{selection?.selectedStage ?? ""}</span>
			<span data-testid="canvas-issues">{JSON.stringify(stageIssues ?? {})}</span>
			<button onClick={() => selection?.selectStage(draft.stages[0]?.name ?? null)}>mock-select-first</button>
			<button
				onClick={() =>
					onDraftChange?.({
						...draft,
						stages: [...draft.stages, { name: "added", trigger: { on: ["manual"] }, executor: { kind: "agent" } }],
					})
				}
			>
				mock-add-stage
			</button>
		</div>
	),
}));

// V4's builder internals are covered by PredicateBuilder.test.tsx; here only
// the open/write-back wiring matters, so Done reports a fixed predicate.
vi.mock("./PredicateBuilderModal", () => ({
	PredicateBuilderModal: ({ open, onDone }: { open: boolean; onDone: (value: unknown) => void }) =>
		open ? (
			<div data-testid="predicate-builder-modal">
				<button onClick={() => onDone({ kind: "no_open_findings" })}>mock-builder-done</button>
			</div>
		) : null,
}));

// The editor debounce-calls POST /pipelines/validate; branch that off the create
// POST so a test's create-response override does not also change validation.
let createResponse: unknown;
function routePost(url: string) {
	if (url.endsWith("/validate")) return Promise.resolve({ data: { valid: true, issues: [] }, error: undefined });
	return Promise.resolve(createResponse);
}

const def = (id: string, name: string, yamlSource: string) => ({
	id,
	projectId: "proj-1",
	name,
	yamlSource,
	createdAt: "2026-07-01T00:00:00Z",
	updatedAt: "2026-07-10T00:00:00Z",
});

const TWO_STAGE_YAML = "name: review\nstages:\n  - name: a\n  - name: b\n";

function renderPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<PipelineDefinitionsPage projectId="proj-1" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getMock.mockReset().mockResolvedValue({
		data: { definitions: [def("pl-1", "review", TWO_STAGE_YAML)] },
		error: undefined,
	});
	createResponse = { data: { definition: def("pl-2", "new", "name: new\n") }, error: undefined };
	postMock.mockReset().mockImplementation((url: string) => routePost(url));
	putMock
		.mockReset()
		.mockResolvedValue({ data: { definition: def("pl-1", "review", TWO_STAGE_YAML) }, error: undefined });
	deleteMock.mockReset().mockResolvedValue({ data: { id: "pl-1", deleted: true }, error: undefined });
});

afterEach(() => vi.restoreAllMocks());

describe("PipelineDefinitionsPage", () => {
	it("lists definitions with a derived stage count", async () => {
		renderPage();
		const row = (await screen.findByText("review")).closest("tr")!;
		expect(within(row).getByText("2")).toBeInTheDocument();
		expect(getMock).toHaveBeenCalledWith("/api/v1/pipelines", { params: { query: { project: "proj-1" } } });
	});

	it("creates a definition through the editor and returns to the list", async () => {
		renderPage();
		await screen.findByText("review");
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: /New pipeline/ }));
		const editor = screen.getByLabelText("Pipeline YAML");
		await user.clear(editor);
		await user.type(editor, "name: created");
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/pipelines", {
				params: { query: { project: "proj-1" } },
				body: { yamlSource: "name: created" },
			}),
		);
		// Back to the list view.
		await screen.findByRole("button", { name: /New pipeline/ });
	});

	it("toggles between YAML and Canvas views and defaults to YAML", async () => {
		renderPage();
		await screen.findByText("review");
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: /New pipeline/ }));
		// YAML mode by default: the editor is mounted, the canvas is not.
		expect(screen.getByLabelText("Pipeline YAML")).toBeInTheDocument();
		expect(screen.queryByTestId("pipeline-canvas")).not.toBeInTheDocument();

		await user.click(screen.getByRole("radio", { name: "Canvas" }));
		expect(screen.getByTestId("pipeline-canvas")).toBeInTheDocument();
		expect(screen.queryByLabelText("Pipeline YAML")).not.toBeInTheDocument();

		// Split shows both surfaces at once.
		await user.click(screen.getByRole("radio", { name: "Split" }));
		expect(screen.getByTestId("pipeline-canvas")).toBeInTheDocument();
		expect(screen.getByLabelText("Pipeline YAML")).toBeInTheDocument();
	});

	it("opens the settings modal from the top bar and commits edits into the draft", async () => {
		renderPage();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Settings" }));
		expect(screen.getByText("Pipeline settings")).toBeInTheDocument();

		const name = screen.getByRole("textbox", { name: "Pipeline name" });
		await user.clear(name);
		await user.type(name, "renamed");
		await user.click(screen.getByRole("button", { name: "Done" }));

		// Modal closed; Done reserialized the draft (normalized shape) into the
		// YAML buffer.
		expect(screen.queryByText("Pipeline settings")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Pipeline YAML")).toHaveValue(
			"name: renamed\nstages:\n  - name: a\n    executor:\n      kind: agent\n  - name: b\n    executor:\n      kind: agent\n",
		);
	});

	it("closes the settings modal on Cancel without touching the buffer", async () => {
		renderPage();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Settings" }));
		const name = screen.getByRole("textbox", { name: "Pipeline name" });
		await user.clear(name);
		await user.type(name, "scrapped");
		await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

		expect(screen.queryByText("Pipeline settings")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Pipeline YAML")).toHaveValue(TWO_STAGE_YAML);
	});

	it("saves the edited YAML buffer when updating an existing definition", async () => {
		renderPage();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		const editor = screen.getByLabelText("Pipeline YAML");
		await user.clear(editor);
		await user.type(editor, "name: edited");
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(putMock).toHaveBeenCalledWith("/api/v1/pipelines/{id}", {
				params: { path: { id: "pl-1" } },
				body: { yamlSource: "name: edited" },
			}),
		);
	});

	it("surfaces save-rejection issues in the Problems panel and keeps the buffer", async () => {
		createResponse = {
			data: undefined,
			error: {
				code: "PIPELINE_VALIDATION_FAILED",
				message: "pipeline definition is invalid",
				details: {
					issues: [
						{ path: "stages[0].name", message: "is required" },
						{ path: "name", message: "must not be empty" },
					],
				},
			},
		};
		renderPage();
		await screen.findByText("review");
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: /New pipeline/ }));
		await user.click(screen.getByRole("button", { name: "Save" }));

		const panel = await screen.findByTestId("problems-panel");
		expect(within(panel).getByText("Must resolve before saving")).toBeInTheDocument();
		expect(within(panel).getByText("stages[0].name")).toBeInTheDocument();
		expect(within(panel).getByText("is required")).toBeInTheDocument();
		expect(within(panel).getByText("must not be empty")).toBeInTheDocument();
		// Top-bar indicator counts the same problems; Save is now gated.
		expect(screen.getByText("2 problems")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		// Buffer intact; the editor is still open.
		expect(screen.getByLabelText("Pipeline YAML")).toBeInTheDocument();
	});

	it("syncs a canvas edit into the YAML pane in split view", async () => {
		renderPage();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("radio", { name: "Split" }));

		await user.click(screen.getByRole("button", { name: "mock-add-stage" }));

		// The draft edit reserializes into the buffer immediately (no debounce on
		// the canvas -> YAML direction) and the canvas shows the new stage.
		expect((screen.getByLabelText("Pipeline YAML") as HTMLTextAreaElement).value).toContain("added");
		expect(screen.getByTestId("canvas-stages")).toHaveTextContent("a,b,added");
	});

	it("parses YAML edits back into the canvas after the debounce", async () => {
		renderPage();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("radio", { name: "Split" }));
		expect(screen.getByTestId("canvas-stages")).toHaveTextContent("a,b");

		fireEvent.change(screen.getByLabelText("Pipeline YAML"), {
			target: { value: "name: review\nstages:\n  - name: zeta\n" },
		});

		await waitFor(() => expect(screen.getByTestId("canvas-stages")).toHaveTextContent(/^zeta$/), { timeout: 2000 });
	});

	it("keeps the last good graph on a YAML parse error and gates Save", async () => {
		renderPage();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("radio", { name: "Split" }));
		expect(screen.getByTestId("yaml-parse-status")).toHaveTextContent("parsed");

		fireEvent.change(screen.getByLabelText("Pipeline YAML"), { target: { value: "name: [broken" } });

		await waitFor(() => expect(screen.getByTestId("yaml-parse-status")).toHaveTextContent("YAML error"), {
			timeout: 2000,
		});
		// The canvas still renders the pre-error graph (mockup 1c: the editor
		// never throws the drawing away mid-edit).
		expect(screen.getByTestId("canvas-stages")).toHaveTextContent("a,b");
		// The parse error is a blocking problem: panel row + disabled Save.
		expect(within(screen.getByTestId("problems-panel")).getByText(/YAML syntax error/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("renders live validate problems with Reveal selecting the stage", async () => {
		postMock.mockImplementation((url: string) => {
			if (url.endsWith("/validate")) {
				return Promise.resolve({
					data: { valid: false, issues: [{ path: "stages[0].executor.kind", message: "unknown executor kind" }] },
					error: undefined,
				});
			}
			return Promise.resolve(createResponse);
		});
		renderPage();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("radio", { name: "Split" }));

		const panel = await screen.findByTestId("problems-panel");
		expect(within(panel).getByText("stages[0].executor.kind")).toBeInTheDocument();
		expect(within(panel).getByText("unknown executor kind")).toBeInTheDocument();
		expect(screen.getByText("1 problem")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		// The affected node gets its badge messages.
		expect(screen.getByTestId("canvas-issues")).toHaveTextContent('{"a":["unknown executor kind"]}');

		// Reveal selects the offending stage; the split view scrolls the YAML
		// pane to its block (stage `a` starts on line 3 of TWO_STAGE_YAML).
		await user.click(within(panel).getByRole("button", { name: "Reveal" }));
		expect(screen.getByTestId("canvas-selected")).toHaveTextContent("a");
		expect(screen.getByLabelText("Pipeline YAML")).toHaveAttribute("data-reveal-line", "3");
	});

	it("opens the predicate builder from the inspector and writes routes.when back", async () => {
		renderPage();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("radio", { name: "Canvas" }));

		// Selecting a node mounts the inspector for that stage.
		await user.click(screen.getByRole("button", { name: "mock-select-first" }));
		const inspector = await screen.findByTestId("stage-inspector");
		expect(within(inspector).getByText("Stage: a")).toBeInTheDocument();

		// Edit condition opens V4's builder; Done writes the predicate into the
		// selected stage's routes.when on the draft.
		await user.click(within(inspector).getByRole("button", { name: /Edit condition/ }));
		await user.click(screen.getByRole("button", { name: "mock-builder-done" }));

		expect(within(inspector).getByTestId("routes-when-summary")).toHaveTextContent("no_open_findings");

		// The draft edit reserialized into the YAML buffer.
		await user.click(screen.getByRole("radio", { name: "YAML" }));
		expect((screen.getByLabelText("Pipeline YAML") as HTMLTextAreaElement).value).toContain("no_open_findings");
	});

	it("confirms before deleting a definition", async () => {
		renderPage();
		await screen.findByText("review");
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: /Delete review/ }));
		expect(deleteMock).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
		expect(deleteMock).toHaveBeenCalledWith("/api/v1/pipelines/{id}", { params: { path: { id: "pl-1" } } });
	});
});
