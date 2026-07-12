import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const instructionFiles = [
	"agent-instructions/source/55-extensions.md",
	"AGENTS.md",
	"AGENTS.shared.md",
	"CLAUDE.md",
	"GEMINI.md",
];

const contractFiles = [
	"agent-instructions/source/30-polypowers.md",
	"AGENTS.md",
	"AGENTS.shared.md",
	"CLAUDE.md",
	"GEMINI.md",
];

const repoRoot = new URL("../", import.meta.url);

async function readInstructionFile(path) {
	return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

// Lockfiles are the ground truth for "which package manager does frontend/ use".
// `frontend/pnpm-workspace.yaml` exists upstream (it configures Electron packaging
// for anyone who does use pnpm) and is deliberately NOT consulted here: a workspace
// settings file is not a lockfile and does not make this a pnpm project.
const frontendLockfiles = {
	npm: "frontend/package-lock.json",
	pnpm: "frontend/pnpm-lock.yaml",
	yarn: "frontend/yarn.lock",
	bun: "frontend/bun.lockb",
};

function detectFrontendPackageManager() {
	const present = Object.entries(frontendLockfiles)
		.filter(([, lock]) => existsSync(new URL(lock, repoRoot)))
		.map(([manager]) => manager);
	assert.equal(
		present.length,
		1,
		`expected exactly one frontend lockfile; found: ${present.length ? present.join(", ") : "none"}`,
	);
	return present[0];
}

async function frontendScripts() {
	const manifest = JSON.parse(await readFile(new URL("frontend/package.json", repoRoot), "utf8"));
	return manifest.scripts ?? {};
}

// The foreign-package-manager guard is an ALLOWLIST, not a parser.
//
// The previous design tried to decide whether a prose mention of `pnpm` was
// "negated" by parsing English — splitting sentences into clauses and hunting for
// negation words. Two independent review cycles each broke it with a new
// counterexample ("The frontend uses pnpm, not npm.", "Do not use npm; use pnpm.",
// "Do not use the following package manager: pnpm", `shouldn't`/`prohibited`/…).
// That is not a run of bugs, it is the design: a sound negation parser for English
// prose does not exist, and an unsound guard in the FALSE-NEGATIVE direction is
// worse than no guard — it grants confidence about exactly the class of defect this
// gate exists to catch.
//
// So: the token of any package manager the frontend lockfile contradicts (`pnpm`,
// `yarn`, `bun`) is FORBIDDEN ANYWHERE in the agent-instruction files — prose, code
// fences, headings, anywhere — except for the exact permitted strings below. Any
// other occurrence fails the gate.
//
// Within its LEXICAL scope this is sound in the dangerous direction BY CONSTRUCTION.
// A new sentence that NAMES pnpm cannot pass, however it is phrased, because it is
// not on the allowlist. No parser, no negation vocabulary, no clause scope. Note the
// load-bearing qualifier: a directive that never names the tool ("use the package
// manager the workspace file implies") carries no token, so it passes — that is a
// real false negative, not a rhetorical caveat. See the threat model below.
// False positives are the only failure mode the guard CAN see, and they are cheap
// and self-correcting: a human reads the sentence once and adds a reviewed entry.
//
// The unit of permission is a WHOLE LINE, not a substring. (Review cycle 3 broke the
// substring version: an allowlisted span could be LAUNDERED by embedding it in a
// hostile line — "No agent should reach for pnpm here unless npm fails; in that case,
// use the forbidden manager." masked the permitted clause and left no forbidden token
// behind, and "Use the package manager represented by `frontend/pnpm-lock.yaml` for
// all frontend commands." did the same with a file name. Both directed an agent at
// pnpm and both PASSED.) A line carrying a forbidden token now passes only if the
// ENTIRE line, normalized, equals a reviewed entry. Appending or prepending anything
// to a permitted line changes the line, so the equality fails and the line is flagged.
// There is no span to hide behind, because there are no spans.
//
// Normalization (`normalizeLine`) is deliberately confined to things that cannot
// carry a directive: surrounding whitespace, internal whitespace runs, letter case,
// and a leading run of markdown structure markers (blockquote `>`, list bullet,
// ordered-list number, heading `#`). Prefix markers are pure structure — no wording
// an agent could act on lives in them — so folding them cannot widen the permitted
// surface by any sentence. Everything else about the line must match exactly.
//
// Consequence for the instruction prose: a permitted mention must occupy its own
// unwrapped line. Hard-wrapping a permitted sentence across two lines no longer
// matches (and must not — a paragraph-level match would just re-open the same hole
// at a larger unit). That is a feature: the reviewable unit and the matched unit are
// the same thing, and a reviewer sees exactly the lines that are allowed to name a
// foreign manager. `agent-instructions/source/55-extensions.md` is written to that
// shape; `npm run agents` regenerates the client files from it.
//
// `why` is mandatory; the "no dead allowlist entries" test below keeps the list from
// silently growing past what the instructions actually say.
const MANAGER_MENTION_ALLOWLIST = [
	{
		text: "`frontend/pnpm-lock.yaml`",
		why: "a bare file name on its own line — the lockfile that does NOT exist here, cited as ground truth; a file name alone directs nobody",
	},
	{
		text: "`frontend/pnpm-workspace.yaml`",
		why: "a bare file name on its own line — the upstream Electron packaging settings file the instructions must be able to explain away",
	},
	{
		text: "**Frontend gates — the frontend is an npm project, not pnpm.**",
		why: "the bullet heading that states the rule itself — the one place pnpm is named as the wrong answer",
	},
	{
		text: "No agent should reach for pnpm here.",
		why: "the prohibition sentence, alone on its line, that tells agents NOT to use pnpm",
	},
];

// Fold only what cannot carry a directive: outer/inner whitespace, case, and a
// leading run of markdown structure markers. Nothing else.
const LEADING_MARKUP = /^(?:\s*(?:>|[-*+]|\d+[.)]|#{1,6})\s+)*\s*/;

function normalizeLine(line) {
	return line.replace(LEADING_MARKUP, "").trim().replace(/\s+/g, " ").toLowerCase();
}

function allowlistedLines(allowlist) {
	return new Set(allowlist.map((entry) => normalizeLine(entry.text)));
}

// THREAT MODEL — say plainly what this guard is, and what it is not.
//
// This guard defends against ACCIDENTAL DRIFT: a well-meaning author writing "the
// frontend is pnpm/vite" or pasting a `pnpm install` line into the instructions.
// That is the actual #293 failure mode — a typo-grade mistake, not an attack — and
// a lexical whole-line allowlist closes it completely, because every line that names
// a contradicted manager must be a line a human reviewed on purpose.
//
// It is NOT a defense against a determined adversary who controls the instruction
// text. A lexical guard cannot be:
//   * unicode homoglyphs (Cyrillic `а` in `pnpm`) and other rendering tricks render
//     identically to a human and to the model, and carry no ASCII token;
//   * HTML/markdown tricks (comments, entities, zero-width joiners) hide or rebuild
//     text after the scan;
//   * semantic directives that never name the tool at all — "use the other package
//     manager", "use the manager the workspace file implies" — evade it by construction;
//   * and an adversary who can edit the instruction files can also edit the allowlist
//     (and this file), which ends the discussion.
// No token-based check closes any of that. Do not read a green gate as "the
// instructions are not adversarially compromised", and do not read it as "the
// instructions did not accidentally drift" either — a tool-unnamed directive
// ("use the package manager the workspace file implies") is accidental drift that
// carries no token, so this guard cannot see it. Read a green gate as exactly what
// it proves: "no line of the instructions LEXICALLY names a package manager the
// lockfile contradicts, except lines a human reviewed on purpose".
//
// De-obfuscation (below) exists inside that modest scope. Shell fragmentation —
// `p""npm install`, `pnp\m install` — is worth collapsing not because it makes the
// guard adversary-proof (it does not; see above) but because it is cheap, and because
// an awkwardly-quoted copy-pasted command is a plausible ACCIDENT, which is exactly
// the class this guard is for.
//
// The pass strips shell quoting (`"`, `'`) and backslash escapes, which is what a
// POSIX shell does to a word before executing it, then re-scans. Both the raw line and
// the de-obfuscated line are scanned; a token in EITHER is a defect, so collapsing
// quotes can never lose an ordinary mention. The allowlist is matched on the RAW line
// only, so a reviewed line is decided by exactly the text a human read.
function deobfuscateShellWord(text) {
	return text.replace(/\\(.)/g, "$1").replace(/["']/g, "");
}

// Every line that names `manager` and is not, in its entirety, a reviewed line.
// Word-anchored, so `bundle` is not a `bun` mention and `pnpm/vite` is a `pnpm` one.
function forbiddenManagerMentions(body, manager, allowlist = MANAGER_MENTION_ALLOWLIST) {
	const token = new RegExp(`\\b${manager}\\b`, "i");
	const permitted = allowlistedLines(allowlist);
	const names = (text) => token.test(text) || token.test(deobfuscateShellWord(text));

	return body
		.split("\n")
		.map((text, index) => ({ line: index + 1, text: text.trim(), normalized: normalizeLine(text) }))
		.filter(({ text, normalized }) => names(text) && !permitted.has(normalized))
		.map(({ line, text }) => ({ line, text }));
}

describe("agent instructions SDLC audit gate", () => {
	for (const file of instructionFiles) {
		it(`${file} requires durable lifecycle markers`, async () => {
			const body = await readInstructionFile(file);

			assert.match(body, /SDLC audit markers/);
			assert.match(body, /Planning/);
			assert.match(body, /review\s+requested/);
			assert.match(body, /review\s+verdict/);
			assert.match(body, /CI\s+run/);
			assert.match(body, /final-review verdict/);
			assert.match(body, /PR comment/);
			assert.match(body, /review-passed/);
			assert.match(body, /ao activity/);
			assert.match(body, /\/api\/v1\/events/);
			assert.match(body, /Slack/);
		});

		it(`${file} blocks autonomous merge without a clean current-head final-review artifact`, async () => {
			const body = await readInstructionFile(file);

			assert.match(body, /Autonomous merge is blocked\s+unless/);
			assert.match(body, /current head SHA/);
			assert.match(body, /clean final-review verdict/);
			assert.match(body, /review-passed/);
		});
	}
});

describe("agent instructions name the frontend package manager the repo actually uses", () => {
	it("the repo has exactly one frontend lockfile", () => {
		assert.equal(detectFrontendPackageManager(), "npm");
	});

	for (const file of instructionFiles) {
		it(`${file} never names a package manager the frontend lockfile contradicts`, async () => {
			const manager = detectFrontendPackageManager();
			const body = await readInstructionFile(file);

			for (const other of Object.keys(frontendLockfiles).filter((m) => m !== manager)) {
				const offenders = forbiddenManagerMentions(body, other);
				assert.deepEqual(
					offenders,
					[],
					`${file} names \`${other}\`, but the frontend is a ${manager} project ` +
						`(${frontendLockfiles[manager]} present, ${frontendLockfiles[other]} absent). ` +
						`Offending lines:\n` +
						offenders.map((o) => `  ${file}:${o.line}: ${o.text}`).join("\n") +
						`\nEither reword the line so it does not name \`${other}\` at all, or — if the mention is ` +
						`genuinely necessary — add a reviewed entry to MANAGER_MENTION_ALLOWLIST in ` +
						`ops/agent-instructions-audit.test.mjs, deliberately and with a stated reason.`,
				);
			}
		});

		it(`${file} documents the frontend install/test/typecheck/build commands`, async () => {
			const body = await readInstructionFile(file);

			assert.match(body, /npm ci --prefix frontend --allow-git=all --ignore-scripts/);
			assert.match(body, /npm test --prefix frontend/);
			assert.match(body, /npm run typecheck --prefix frontend/);
			assert.match(body, /npm run build:web --prefix frontend/);
			// Why the narrow install override exists must travel with the command.
			assert.match(body, /allow-git=none/);
		});

		it(`${file} only names frontend scripts that frontend/package.json declares`, async () => {
			const body = await readInstructionFile(file);
			const scripts = await frontendScripts();

			const named = [...body.matchAll(/npm run ([\w:-]+) --prefix frontend/g)].map((m) => m[1]);
			assert.ok(named.length > 0, "expected the instructions to name at least one frontend npm script");
			for (const script of named) {
				assert.ok(
					Object.hasOwn(scripts, script),
					`instructions name \`npm run ${script} --prefix frontend\`, but frontend/package.json declares no such script`,
				);
			}
		});
	}
});

describe("foreign-package-manager guard is an allowlist, not a parser", () => {
	// (a) The original #293 regression, and the invocation forms.
	it("flags the #293 declaration `frontend is pnpm/vite under frontend/`", () => {
		assert.equal(forbiddenManagerMentions("frontend is pnpm/vite under `frontend/`.", "pnpm").length, 1);
	});

	it("flags an invocation, however it is framed", () => {
		assert.equal(forbiddenManagerMentions("If npm is not available, run `pnpm install` instead.", "pnpm").length, 1);
		assert.equal(forbiddenManagerMentions("```bash\npnpm install\n```", "pnpm").length, 1);
	});

	// (b) Every counterexample that broke the old parser. Under the allowlist these
	// are not "hard cases" — they are simply not on the list, so they fail. The
	// parser's whole negation-scope problem has no analogue here.
	for (const bad of [
		// review cycle 1 — negation in a different clause laundered the directive
		"Use pnpm for frontend; npm is not supported.",
		"The frontend uses pnpm, not npm.",
		"Do not use npm; use pnpm.",
		"pnpm should be used whenever npm cannot install dependencies.",
		"Use pnpm where npm is not installed.",
	]) {
		it(`flags ${JSON.stringify(bad)}`, () => {
			assert.equal(forbiddenManagerMentions(bad, "pnpm").length, 1, `expected \`pnpm\` to be flagged in: ${bad}`);
		});
	}

	// (d) Soundness by construction, not by enumeration: a directive nobody
	// anticipated, phrased in a way no rule in this file mentions, still fails —
	// because passing requires being on the allowlist, not evading a matcher.
	for (const unanticipated of [
		"Agents should prefer pnpm here.",
		"Frontend deps are managed with pnpm.",
		"When in a hurry, pnpm is fine.",
		"pnpm",
	]) {
		it(`flags the unanticipated directive ${JSON.stringify(unanticipated)}`, () => {
			assert.equal(forbiddenManagerMentions(unanticipated, "pnpm").length, 1);
		});
	}

	// Review cycle 2's counterexamples. The old parser FAILED this one because a
	// colon split the negation away from the mention, and its negation vocabulary
	// knew `don't` but not `shouldn't`/`mustn't`/`prohibited`/`unsupported`. The
	// allowlist has no vocabulary at all, so these are flagged too — a deliberate
	// FALSE POSITIVE, which is the safe direction and is fixed by adding an entry.
	for (const negatedButUnlisted of [
		"Do not use the following package manager: pnpm",
		"You shouldn't use pnpm.",
		"Agents mustn't use pnpm.",
		"pnpm is prohibited.",
		"pnpm is unsupported here.",
	]) {
		it(`flags the unlisted (even if negated) sentence ${JSON.stringify(negatedButUnlisted)}`, () => {
			assert.equal(
				forbiddenManagerMentions(negatedButUnlisted, "pnpm").length,
				1,
				"an unlisted sentence must fail even when a human would read it as a prohibition: " +
					"false positives are the guard's only permitted failure mode",
			);
		});
	}

	it("clears such a sentence only when a human adds it to the allowlist, deliberately", () => {
		const sentence = "Do not use the following package manager: pnpm";
		const allowlist = [
			...MANAGER_MENTION_ALLOWLIST,
			{ text: sentence, why: "reviewed prohibition wording (test fixture)" },
		];

		assert.deepEqual(forbiddenManagerMentions(sentence, "pnpm", allowlist), []);
		// …and the new entry launders nothing else: it is an exact string, not a rule.
		assert.equal(forbiddenManagerMentions("Do use the following package manager: pnpm", "pnpm", allowlist).length, 1);
	});

	// (c) No false positives on what the instructions legitimately say — each
	// permitted mention on its own line, exactly as the source file now writes it.
	it("permits the reviewed lines the instructions actually carry", () => {
		assert.deepEqual(
			forbiddenManagerMentions(
				"- **Frontend gates — the frontend is an npm project, not pnpm.**\n" +
					"  `frontend/package.json` + `frontend/package-lock.json` are authoritative.\n" +
					"\n" +
					"  - `frontend/pnpm-lock.yaml`\n" +
					"  - `frontend/pnpm-workspace.yaml`\n" +
					"\n" +
					"  No agent should reach for pnpm here.\n",
				"pnpm",
			),
			[],
		);
	});

	// The same file names, dropped mid-sentence, are NOT permitted — that was
	// laundering vector (2). A permitted mention has to sit on its own line.
	it("does not permit a reviewed file name embedded in an unreviewed sentence", () => {
		assert.equal(
			forbiddenManagerMentions("An upstream `frontend/pnpm-workspace.yaml` is present for Electron packaging.", "pnpm")
				.length,
			1,
		);
		assert.equal(forbiddenManagerMentions("`frontend/pnpm-lock.yaml` does not exist.", "pnpm").length, 1);
	});

	// Hard-wrapping a permitted line across two lines does not match either: the
	// matched unit and the reviewable unit are the same unit, on purpose.
	it("does not permit a reviewed sentence hard-wrapped across lines", () => {
		assert.equal(forbiddenManagerMentions("No agent should reach\nfor pnpm here.", "pnpm").length, 1);
	});

	// Markdown structure markers ahead of a permitted line are folded — they carry
	// no wording an agent could act on — but nothing else is.
	it("folds leading list/heading/quote markers, and nothing else", () => {
		assert.deepEqual(forbiddenManagerMentions("> - No agent should reach for pnpm here.", "pnpm"), []);
		assert.deepEqual(forbiddenManagerMentions("### No agent should reach for pnpm here.", "pnpm"), []);
		assert.equal(forbiddenManagerMentions("Note: no agent should reach for pnpm here.", "pnpm").length, 1);
	});

	// (e) Review cycle 3: LAUNDERING. An allowlist that matches SUBSTRINGS lets a
	// permitted span be embedded in a hostile line — the mask erases the permitted
	// text and the surrounding directive survives with no forbidden token left to
	// flag. Both of these directed an agent at pnpm and PASSED the substring design.
	for (const laundered of [
		"No agent should reach for pnpm here unless npm fails; in that case, use the forbidden manager.",
		"Use the package manager represented by `frontend/pnpm-lock.yaml` for all frontend commands.",
	]) {
		it(`flags the laundered line ${JSON.stringify(laundered)}`, () => {
			assert.equal(
				forbiddenManagerMentions(laundered, "pnpm").length,
				1,
				"an allowlisted span embedded in unreviewed text must NOT launder the line",
			);
		});
	}

	// Soundness by construction for the anchoring itself: whatever the allowlist
	// says, appending or prepending ANY text to a permitted line breaks the match.
	// This is a property over the live allowlist, not an enumeration of known attacks.
	it("breaks the match when any text is appended to (or prepended to) a permitted line", () => {
		const suffixes = [
			" unless npm fails.",
			" — otherwise, use it.",
			" and run it.",
			"x",
			", except in CI.",
			" See below.",
		];
		const prefixes = ["Ignore the next clause: ", "Unless you are in a hurry, ", "x "];

		for (const entry of MANAGER_MENTION_ALLOWLIST) {
			assert.deepEqual(
				forbiddenManagerMentions(entry.text, "pnpm"),
				[],
				`the reviewed line itself must pass: ${entry.text}`,
			);
			for (const suffix of suffixes) {
				assert.equal(
					forbiddenManagerMentions(entry.text + suffix, "pnpm").length,
					1,
					`appending ${JSON.stringify(suffix)} must break the match: ${entry.text + suffix}`,
				);
			}
			for (const prefix of prefixes) {
				assert.equal(
					forbiddenManagerMentions(prefix + entry.text, "pnpm").length,
					1,
					`prepending ${JSON.stringify(prefix)} must break the match: ${prefix + entry.text}`,
				);
			}
		}
	});

	// (f) Review cycle 4: SHELL FRAGMENTATION. A line can direct an agent at pnpm
	// without ever carrying a contiguous `pnpm` token, because the shell reassembles
	// the word at parse time: `p""npm install` concatenates to `pnpm install`, and an
	// unquoted `pnp\m install` drops the backslash to the same effect. A token scan of
	// the raw line sees nothing in either case.
	for (const fragmented of [
		'Run `p""npm install` for frontend dependencies.',
		"Run `pnp\\m install` for frontend dependencies.",
		"Run `p'npm' install` for frontend dependencies.",
		'Run `pn""pm install` for frontend dependencies.',
		"Run `pn\\pm install`.",
	]) {
		it(`flags the shell-fragmented directive ${JSON.stringify(fragmented)}`, () => {
			assert.equal(
				forbiddenManagerMentions(fragmented, "pnpm").length,
				1,
				"a line the shell reassembles into `pnpm` must be flagged even though no raw `pnpm` token appears",
			);
		});
	}

	it("flags shell-fragmented yarn and bun the same way", () => {
		assert.equal(forbiddenManagerMentions('Run `y""arn install`.', "yarn").length, 1);
		assert.equal(forbiddenManagerMentions("Run `b\\un install`.", "bun").length, 1);
	});

	// De-obfuscation must not manufacture offenders out of ordinary prose. Quotes,
	// apostrophes and backticks are everywhere in these files; stripping them may not
	// turn innocent text into a forbidden token, and must not break the allowlist.
	it("does not false-positive on ordinary prose carrying quotes and apostrophes", () => {
		for (const innocent of [
			'Don\'t report "dependencies are unavailable" when they are merely not preinstalled.',
			"`npm run build:web` produces the production web bundle.",
			'The reviewer\'s claim ("the toolchain is missing") is a claim, not a finding.',
			"Electron's bundler config is upstream's business, not ours.",
			"Pass `--allow-git=all` on the command line only — never in `.npmrc`.",
		]) {
			for (const manager of ["pnpm", "yarn", "bun"]) {
				assert.deepEqual(
					forbiddenManagerMentions(innocent, manager),
					[],
					`de-obfuscation must not invent a \`${manager}\` mention in: ${innocent}`,
				);
			}
		}
	});

	it("still permits the reviewed lines, which themselves carry backticks", () => {
		for (const entry of MANAGER_MENTION_ALLOWLIST) {
			assert.deepEqual(
				forbiddenManagerMentions(entry.text, "pnpm"),
				[],
				`the reviewed line must survive de-obfuscation: ${entry.text}`,
			);
		}
	});

	it("reports the offending line number and text", () => {
		const offenders = forbiddenManagerMentions("intro\nsecond line\nrun pnpm install\n", "pnpm");
		assert.deepEqual(offenders, [{ line: 3, text: "run pnpm install" }]);
	});

	// The other contradicted managers get the same treatment, and word boundaries
	// keep `bundle`/`yarnish` prose out of it.
	it("covers yarn and bun without tripping on substrings", () => {
		assert.equal(forbiddenManagerMentions("Run `yarn install` first.", "yarn").length, 1);
		assert.equal(forbiddenManagerMentions("Use bun for speed.", "bun").length, 1);
		assert.deepEqual(forbiddenManagerMentions("npm run build:web produces the production web bundle.", "bun"), []);
	});

	it("carries no dead or unreviewed allowlist entries", async () => {
		const bodies = await Promise.all(instructionFiles.map(readInstructionFile));
		const lines = new Set(bodies.flatMap((body) => body.split("\n").map(normalizeLine)));

		for (const entry of MANAGER_MENTION_ALLOWLIST) {
			assert.ok(entry.why, `allowlist entry ${JSON.stringify(entry.text)} has no stated reason`);
			assert.ok(
				lines.has(normalizeLine(entry.text)),
				`allowlist entry ${JSON.stringify(entry.text)} is not a whole line of any instruction file; ` +
					`the permitted surface must never be wider than what the instructions actually say`,
			);
		}
	});
});

// NOTE (#293): a `triageToolingBlockerClaim()` helper used to live below these
// tests, grading a reviewer's tooling-blocker claim as accepted/rejected. It was
// DELETED, not fixed. It had no production caller — it was defined in this test file
// and exercised only by tests in this same file, so it asserted nothing about the
// repo or about any agent's behavior. And it could not, even in principle, establish
// what it appeared to: it graded a self-reported `attemptedCommand`/`exactError` pair
// and cannot prove a command ever ran. Its bugs (`exactError: " "` accepted as
// evidence; `matchesDeclaredPath()` accepting any whitespace-suffixed text) are
// symptoms of that; a fixed version would still be a rubric applied to unverified
// self-report. The verification contract is enforced where it can actually bind — as
// prose in the instruction files, asserted below — plus the real repo facts
// (lockfile, declared scripts) asserted above.
describe("agent instructions carry the reviewer-claim verification contract", () => {
	for (const file of contractFiles) {
		it(`${file} treats reviewer/subagent claims as evidence candidates, never facts`, async () => {
			const body = await readInstructionFile(file);

			assert.match(body, /evidence candidates, never facts/);
			assert.match(body, /manifests/);
			assert.match(body, /lockfiles/);
			assert.match(body, /declared scripts/);
			assert.match(body, /repo-declared safe install path/);
			assert.match(body, /exact failing command/);
			assert.match(body, /never be reported as/);
		});

		it(`${file} requires the three test-omission states and an explicit sign-off`, async () => {
			const body = await readInstructionFile(file);

			assert.match(body, /actually failed/i);
			assert.match(body, /not run/i);
			assert.match(body, /not preinstalled/i);
			assert.match(body, /sign(s|ed)? off/i);
		});
	}
});
