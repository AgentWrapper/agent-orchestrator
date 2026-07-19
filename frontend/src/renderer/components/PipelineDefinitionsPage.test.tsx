import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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
// the CRUD/validation flow is what's under test, not the editor internals.
vi.mock("./YamlEditor", () => ({
	YamlEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
		<textarea aria-label="Pipeline YAML" value={value} onChange={(e) => onChange(e.target.value)} />
	),
}));

// React Flow needs ResizeObserver + real layout jsdom lacks; the canvas is a
// V2 placeholder here, so stub it and keep the shell/CRUD flow under test.
vi.mock("./PipelineCanvas", () => ({
	PipelineCanvas: () => <div data-testid="pipeline-canvas" />,
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

	it("surfaces each validation issue inline and keeps the buffer", async () => {
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

		expect(await screen.findByText("2 validation issues")).toBeInTheDocument();
		expect(screen.getByText("stages[0].name")).toBeInTheDocument();
		expect(screen.getByText("is required")).toBeInTheDocument();
		expect(screen.getByText("must not be empty")).toBeInTheDocument();
		// Buffer intact; the editor is still open.
		expect(screen.getByLabelText("Pipeline YAML")).toBeInTheDocument();
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
