import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { emptyDraft, parseYamlToDraft, type PipelineDraft, serializeToYaml } from "./pipeline-draft";

// The spec §11 worked example, verbatim. It is the canonical fixture on both
// sides of the wire (the backend parser tests it as testdata/release.yaml), so
// it is what proves the TypeScript mirror did not drift: fan-out, two joins,
// credentials, a failure-path agent, and the pipeline-level defaults block.
const RELEASE_YAML = `name: release
on:
  pr: [merged]

concurrency:
  scope: project
  group: release
  cancel-in-progress: false

defaults:
  on_failure: notify-failure

stages:
  - id: prepare
    executor: command
    workspace: run
    run: |
      test "$(git rev-parse --abbrev-ref HEAD)" = "main"
      mkdir -p "$AO_RUN_DIR"/{artifacts,digests}
      ao release resolve-version > "$AO_RUN_DIR/version"
    on_success: [build-macos, build-windows, build-linux, release-notes]

  - id: build-macos
    executor: command
    workspace: stage
    deadline: 40m
    run: |
      npm ci
      npm run build:mac -- --version "$(cat "$AO_RUN_DIR/version")"
      sha256sum dist/*.dmg > "$AO_RUN_DIR/digests/macos.txt"
      cp dist/*.dmg "$AO_RUN_DIR/artifacts/"
    on_success: verify-digests
    on_failure: diagnose-build

  - id: build-windows
    executor: command
    workspace: stage
    deadline: 40m
    run: |
      npm ci
      npm run build:win -- --version "$(cat "$AO_RUN_DIR/version")"
      sha256sum dist/*.exe > "$AO_RUN_DIR/digests/windows.txt"
      cp dist/*.exe "$AO_RUN_DIR/artifacts/"
    on_success: verify-digests
    on_failure: diagnose-build

  - id: build-linux
    executor: command
    workspace: stage
    deadline: 40m
    run: |
      npm ci
      npm run build:linux -- --version "$(cat "$AO_RUN_DIR/version")"
      sha256sum dist/*.AppImage > "$AO_RUN_DIR/digests/linux.txt"
      cp dist/*.AppImage "$AO_RUN_DIR/artifacts/"
    on_success: verify-digests
    on_failure: diagnose-build

  - id: release-notes
    executor: agent
    agent: claude-code
    workspace: stage
    produces: release-notes.md
    deadline: 15m
    session:
      kill-on: [succeeded, failed]
    prompt: |
      Write release notes for version $(cat "$AO_RUN_DIR/version").
      Use \`git log\` since the previous tag. Group by user-visible change,
      not by commit. Omit internal refactors.
      Write to $AO_OUTPUT, then \`ao pipeline done\`.
      If there are no user-visible changes, \`ao pipeline fail --reason "..."\`.
    on_success: publish-github

  - id: verify-digests
    executor: command
    needs: [build-macos, build-windows, build-linux]
    workspace: run
    run: ao release verify-digests "$AO_RUN_DIR/digests" "$AO_RUN_DIR/artifacts"
    on_success: sign-macos

  - id: sign-macos
    executor: command
    workspace: run
    credentials: [apple-signing]
    deadline: 45m
    run: |
      ao release sign-dmg   "$AO_RUN_DIR/artifacts/"*.dmg
      ao release notarize --wait --timeout 40m "$AO_RUN_DIR/artifacts/"*.dmg
      ao release verify-notarization "$AO_RUN_DIR/artifacts/"*.dmg
    on_success: publish-github

  - id: publish-github
    executor: command
    needs: [sign-macos, release-notes]
    workspace: run
    credentials: [github-release]
    run: |
      gh release create "v$(cat "$AO_RUN_DIR/version")" \\
        "$AO_RUN_DIR/artifacts/"* \\
        --notes-file "$AO_RUN_DIR/agent-outputs/release-notes.md"
    on_success: [update-tap, update-feed]

  - id: update-tap
    executor: command
    workspace: run
    credentials: [homebrew-tap]
    run: ao release bump-cask --version "$(cat "$AO_RUN_DIR/version")"
    on_success: announce
    on_failure: notify-partial

  - id: update-feed
    executor: command
    workspace: run
    credentials: [github-release]
    run: ao release publish-feed --version "$(cat "$AO_RUN_DIR/version")"
    on_success: announce
    on_failure: notify-partial

  - id: announce
    executor: command
    needs: [update-tap, update-feed]
    workspace: run
    credentials: [discord]
    run: |
      ao discord post --file "$AO_RUN_DIR/agent-outputs/release-notes.md" \\
        --title "v$(cat "$AO_RUN_DIR/version")"

  - id: diagnose-build
    executor: agent
    agent: claude-code
    produces: diagnosis.md
    deadline: 15m
    session:
      kill-on: []
    prompt: |
      Build stage \`$AO_FAILED_STAGE\` failed. Its log is at
      $AO_RUN_DIR/stage-logs/$AO_FAILED_STAGE.log and you are in its
      working tree with the failure state intact.
      Diagnose the root cause, write to $AO_OUTPUT, then \`ao pipeline done\`.
    on_success: notify-failure

  - id: notify-failure
    executor: command
    workspace: run
    credentials: [discord]
    run: |
      ao discord post --title "release failed at $AO_FAILED_STAGE" \\
        --body "outcome: $AO_FAILED_OUTCOME"

  - id: notify-partial
    executor: command
    workspace: run
    credentials: [discord]
    run: |
      ao discord post --urgent --title "PARTIAL RELEASE" \\
        --body "GitHub release for v$(cat "$AO_RUN_DIR/version") is live but \\
      $AO_FAILED_STAGE failed. Manual reconciliation required."
`;
// One deviation from the spec text, shared with backend testdata/release.yaml:
// §11 wraps notify-partial's --body across a backslash continuation whose
// second line sits at column 0, which is not legal inside a block scalar. The
// continuation is indented into the block here so the fixture parses.

function parseOrThrow(source: string): PipelineDraft {
	const { draft, parseError } = parseYamlToDraft(source);
	if (!draft) throw new Error(parseError ?? "parse returned no draft");
	return draft;
}

describe("pipeline-draft codec, spec §11 release example", () => {
	const draft = parseOrThrow(RELEASE_YAML);

	it("parses the pipeline-level blocks", () => {
		expect(draft.name).toBe("release");
		expect(draft.on).toEqual({ pr: ["merged"] });
		expect(draft.concurrency).toEqual({ scope: "project", group: "release", cancelInProgress: false });
		expect(draft.defaults).toEqual({ onFailure: "notify-failure" });
	});

	it("parses every stage", () => {
		expect(draft.stages).toHaveLength(14);
		expect(draft.stages.map((s) => s.id)).toEqual([
			"prepare",
			"build-macos",
			"build-windows",
			"build-linux",
			"release-notes",
			"verify-digests",
			"sign-macos",
			"publish-github",
			"update-tap",
			"update-feed",
			"announce",
			"diagnose-build",
			"notify-failure",
			"notify-partial",
		]);
	});

	it("parses the fan-out, the joins, and the credential stages", () => {
		const byId = new Map(draft.stages.map((s) => [s.id, s]));
		expect(byId.get("prepare")?.onSuccess).toEqual(["build-macos", "build-windows", "build-linux", "release-notes"]);
		expect(byId.get("verify-digests")?.needs).toEqual(["build-macos", "build-windows", "build-linux"]);
		expect(byId.get("publish-github")?.needs).toEqual(["sign-macos", "release-notes"]);
		expect(byId.get("sign-macos")?.credentials).toEqual(["apple-signing"]);
		expect(byId.get("build-macos")?.deadline).toBe("40m");
		expect(byId.get("build-macos")?.onFailure).toBe("diagnose-build");
		// A single successor authored as a scalar becomes a one-element list.
		expect(byId.get("build-macos")?.onSuccess).toEqual(["verify-digests"]);
	});

	it("distinguishes an absent session block from kill-on: []", () => {
		const byId = new Map(draft.stages.map((s) => [s.id, s]));
		expect(byId.get("release-notes")?.session).toEqual({ killOn: ["succeeded", "failed"] });
		// "never kill" is an explicit empty list, not the absence of the key.
		expect(byId.get("diagnose-build")?.session).toEqual({ killOn: [] });
		expect(byId.get("prepare")?.session).toBeUndefined();
	});

	it("round-trips through YAML without losing a field", () => {
		expect(parseOrThrow(serializeToYaml(draft))).toEqual(draft);
	});

	it("serializes stably (serialize is idempotent over the parse)", () => {
		const once = serializeToYaml(draft);
		expect(serializeToYaml(parseOrThrow(once))).toBe(once);
	});

	it("keeps kill-on: [] and cancel-in-progress: false in the emitted YAML", () => {
		const emitted = yaml.load(serializeToYaml(draft)) as Record<string, unknown>;
		expect((emitted.concurrency as Record<string, unknown>)["cancel-in-progress"]).toBe(false);
		const stages = emitted.stages as Array<Record<string, unknown>>;
		const diagnose = stages.find((s) => s.id === "diagnose-build");
		expect(diagnose?.session).toEqual({ "kill-on": [] });
	});

	it("emits the trigger block under a string `on` key", () => {
		// js-yaml quotes the key ('on':) because YAML 1.1 read `on` as a boolean.
		// Both js-yaml and yaml.v3 decode the quoted form back to the string key,
		// so the daemon still sees the trigger block; this locks that in.
		const emitted = yaml.load(serializeToYaml(draft)) as Record<string, unknown>;
		expect(emitted.on).toEqual({ pr: ["merged"] });
	});
});

describe("pipeline-draft on_success scalar and list forms", () => {
	it("accepts a scalar and a list", () => {
		const scalar = parseOrThrow("name: p\nstages:\n  - id: a\n    executor: command\n    on_success: b\n");
		const list = parseOrThrow("name: p\nstages:\n  - id: a\n    executor: command\n    on_success: [b, c]\n");
		expect(scalar.stages[0].onSuccess).toEqual(["b"]);
		expect(list.stages[0].onSuccess).toEqual(["b", "c"]);
	});

	it("emits a scalar for one successor and a list for several", () => {
		const one = serializeToYaml({ name: "p", stages: [{ id: "a", executor: "command", onSuccess: ["b"] }] });
		const many = serializeToYaml({ name: "p", stages: [{ id: "a", executor: "command", onSuccess: ["b", "c"] }] });
		expect(one).toContain("on_success: b");
		expect(yaml.load(many)).toMatchObject({ stages: [{ on_success: ["b", "c"] }] });
	});
});

describe("pipeline-draft pruning", () => {
	it("omits empty optional fields from the YAML", () => {
		const emitted = serializeToYaml({
			name: "p",
			on: {},
			concurrency: {},
			defaults: {},
			stages: [{ id: "s", executor: "agent", agent: "claude-code", credentials: [], needs: [], onSuccess: [] }],
		});
		expect(emitted).not.toContain("on:");
		expect(emitted).not.toContain("concurrency:");
		expect(emitted).not.toContain("defaults:");
		expect(emitted).not.toContain("credentials:");
		expect(emitted).not.toContain("needs:");
		expect(emitted).not.toContain("on_success:");
	});

	it("keeps meaningful false through serialization", () => {
		const emitted = yaml.load(
			serializeToYaml({
				name: "p",
				concurrency: { scope: "pr", cancelInProgress: false },
				stages: [{ id: "s", executor: "agent" }],
			}),
		) as Record<string, unknown>;
		expect((emitted.concurrency as Record<string, unknown>)["cancel-in-progress"]).toBe(false);
	});

	it("round-trips an empty pipeline", () => {
		expect(parseOrThrow(serializeToYaml(emptyDraft()))).toEqual(emptyDraft());
	});
});

describe("pipeline-draft parse failures", () => {
	it("reports a YAML syntax error and returns no draft", () => {
		const { draft, parseError } = parseYamlToDraft("name: [unclosed\n");
		expect(parseError).toBeTruthy();
		expect(draft).toBeNull();
	});

	it("rejects a document that is not a mapping", () => {
		const { draft, parseError } = parseYamlToDraft("- just\n- a list\n");
		expect(parseError).toBe("pipeline definition must be a YAML mapping");
		expect(draft).toBeNull();
	});

	it("parses a semantically-invalid but well-formed document without error", () => {
		// Empty name + no stages is a validation failure server-side, but a valid
		// YAML document the codec still turns into a draft.
		const { draft, parseError } = parseYamlToDraft("name: ''\nstages: []\n");
		expect(parseError).toBeUndefined();
		expect(draft).toEqual({ name: "", stages: [] });
	});
});
