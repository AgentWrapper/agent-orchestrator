import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { createCodeReviewStore } from "../../core/src/code-review-store.ts";
import {
  createInitialCanonicalLifecycle,
  deriveLegacyStatus,
} from "../../core/src/lifecycle-state.ts";
import { writeMetadata } from "../../core/src/metadata.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(WEB_DIR, "../..");
const PROJECT_ID = "todo-app";
const SESSION_ID = "todo-1";
const ORCHESTRATOR_ID = "todo-orchestrator";
const PR_URL = "https://github.com/acme/todo-app/pull/1";

interface Fixture {
  rootDir: string;
  homeDir: string;
  projectDir: string;
  globalConfigPath: string;
  localConfigPath: string;
  tmuxSessionPrefix: string;
  tmuxSessions: string[];
}

interface ServerHandle {
  baseUrl: string;
  stop: () => Promise<void>;
}

function shellJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("'", "'\"'\"'");
}

function buildStaticReviewCommand(findings: unknown[], delayMs = 0): string {
  const payload = { findings };
  return `node -e 'setTimeout(() => console.log(${shellJson(JSON.stringify(payload))}), ${delayMs})'`;
}

function buildFindingReviewCommand(delayMs: number): string {
  return buildStaticReviewCommand(
    [
      {
        severity: "warning",
        title: "E2E reviewer finding",
        body: "The e2e review command created this finding.",
        filePath: "README.md",
        startLine: 1,
        confidence: 0.9,
      },
    ],
    delayMs,
  );
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AO E2E",
      GIT_AUTHOR_EMAIL: "ao-e2e@example.com",
      GIT_COMMITTER_NAME: "AO E2E",
      GIT_COMMITTER_EMAIL: "ao-e2e@example.com",
    },
  });
}

function startCodexBackedTmux(sessionName: string, cwd: string): void {
  execFileSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      cwd,
      "exec codex --no-alt-screen --sandbox danger-full-access --ask-for-approval never",
    ],
    { stdio: "ignore" },
  );
}

function killTmuxSession(sessionName: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
  } catch {
    // Best effort cleanup for local e2e fixtures.
  }
}

function listTmuxSessions(): string[] {
  try {
    return execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((sessionName) => sessionName.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function killReviewBoardTmuxSessions(fixture: Fixture): void {
  const sessionNames = new Set([
    ...fixture.tmuxSessions,
    ...listTmuxSessions().filter((sessionName) =>
      sessionName.startsWith(fixture.tmuxSessionPrefix),
    ),
  ]);

  for (const sessionName of sessionNames) {
    killTmuxSession(sessionName);
  }
}

function installFixtureSignalCleanup(fixture: Fixture): void {
  process.once("exit", () => killReviewBoardTmuxSessions(fixture));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      killReviewBoardTmuxSessions(fixture);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

function captureTmuxPane(sessionName: string): string {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-t", sessionName], {
      encoding: "utf-8",
    });
  } catch {
    return "";
  }
}

async function waitForTmuxText(
  sessionName: string,
  pattern: RegExp,
  label: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCapture = "";

  while (Date.now() < deadline) {
    lastCapture = captureTmuxPane(sessionName);
    if (pattern.test(lastCapture)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }

  throw new Error(`Expected tmux text: ${label}\n${lastCapture}`);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a TCP port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
  });
}

function probe(url: URL): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "HEAD",
        timeout: 2_000,
      },
      (res) => {
        res.resume();
        resolveProbe(true);
      },
    );
    req.on("error", () => resolveProbe(false));
    req.on("timeout", () => {
      req.destroy();
      resolveProbe(false);
    });
    req.end();
  });
}

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = new URL("/projects/todo-app", baseUrl);
  while (Date.now() < deadline) {
    if (await probe(url)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Next dev server did not respond at ${baseUrl} within ${timeoutMs}ms`);
}

async function startWebServer(fixture: Fixture): Promise<ServerHandle> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output: string[] = [];
  const child: ChildProcess = spawn("pnpm", ["dev:next"], {
    cwd: WEB_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: fixture.homeDir,
      AO_GLOBAL_CONFIG: fixture.globalConfigPath,
      AO_CONFIG_PATH: fixture.localConfigPath,
      AO_CODE_REVIEW_COMMAND: buildFindingReviewCommand(1_000),
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
      AO_NO_UPDATE_NOTIFIER: "1",
      AGENT_ORCHESTRATOR_CI: "1",
    },
  });

  const collect = (chunk: Buffer) => {
    output.push(chunk.toString());
    if (output.length > 80) output.splice(0, output.length - 80);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  try {
    await waitForServer(baseUrl, 45_000);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${output.join("").trim()}`,
      { cause: error },
    );
  }

  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolveStop();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveStop();
        });
      });
    },
  };
}

function createFixture(): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), "ao-review-board-e2e-"));
  const homeDir = join(rootDir, "home");
  const projectDir = join(rootDir, "todo-app");
  const globalConfigPath = join(homeDir, ".agent-orchestrator", "config.yaml");
  const localConfigPath = join(projectDir, "agent-orchestrator.yaml");
  const sessionsDir = join(homeDir, ".agent-orchestrator", "projects", PROJECT_ID, "sessions");
  const tmuxSuffix = basename(rootDir).replace(/[^a-zA-Z0-9_-]/g, "-");
  const tmuxSessionPrefix = `${tmuxSuffix}-`;
  const workerTmuxName = `${tmuxSuffix}-worker`;
  const orchestratorTmuxName = `${tmuxSuffix}-orchestrator`;

  mkdirSync(dirname(globalConfigPath), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  writeFileSync(join(projectDir, "README.md"), "# Todo App\n");
  writeFileSync(localConfigPath, "agent: codex\nruntime: tmux\nworkspace: worktree\n");
  git(projectDir, ["init", "-b", "main"]);
  git(projectDir, ["add", "."]);
  git(projectDir, ["commit", "-m", "initial"]);
  startCodexBackedTmux(workerTmuxName, projectDir);
  startCodexBackedTmux(orchestratorTmuxName, REPO_ROOT);

  writeFileSync(
    globalConfigPath,
    [
      "defaults:",
      "  runtime: tmux",
      "  agent: codex",
      "  workspace: worktree",
      "  notifiers: []",
      "notifiers: {}",
      "projects:",
      `  ${PROJECT_ID}:`,
      `    path: ${JSON.stringify(projectDir)}`,
      "    displayName: Todo App",
      "    defaultBranch: main",
      "    sessionPrefix: todo",
      "",
    ].join("\n"),
  );

  process.env["HOME"] = homeDir;
  process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;
  process.env["AO_CONFIG_PATH"] = localConfigPath;

  const createdAt = new Date("2026-05-13T10:00:00.000Z");
  const workerLifecycle = createInitialCanonicalLifecycle("worker", createdAt);
  workerLifecycle.session.state = "idle";
  workerLifecycle.session.reason = "awaiting_external_review";
  workerLifecycle.session.startedAt = createdAt.toISOString();
  workerLifecycle.session.lastTransitionAt = createdAt.toISOString();
  workerLifecycle.pr.state = "open";
  workerLifecycle.pr.reason = "review_pending";
  workerLifecycle.pr.number = 1;
  workerLifecycle.pr.url = PR_URL;
  workerLifecycle.pr.lastObservedAt = createdAt.toISOString();
  workerLifecycle.runtime.state = "alive";
  workerLifecycle.runtime.reason = "process_running";
  workerLifecycle.runtime.lastObservedAt = createdAt.toISOString();
  workerLifecycle.runtime.handle = { id: workerTmuxName, runtimeName: "tmux", data: {} };
  workerLifecycle.runtime.tmuxName = workerTmuxName;

  writeMetadata(sessionsDir, SESSION_ID, {
    worktree: projectDir,
    branch: "main",
    status: deriveLegacyStatus(workerLifecycle),
    lifecycle: workerLifecycle,
    project: PROJECT_ID,
    pr: PR_URL,
    displayName: "E2E todo review target",
    agent: "codex",
    createdAt: createdAt.toISOString(),
    tmuxName: workerTmuxName,
    runtimeHandle: { id: workerTmuxName, runtimeName: "tmux", data: {} },
  });

  const orchestratorLifecycle = createInitialCanonicalLifecycle("orchestrator", createdAt);
  orchestratorLifecycle.session.state = "working";
  orchestratorLifecycle.session.reason = "task_in_progress";
  orchestratorLifecycle.session.startedAt = createdAt.toISOString();
  orchestratorLifecycle.session.lastTransitionAt = createdAt.toISOString();
  orchestratorLifecycle.runtime.state = "alive";
  orchestratorLifecycle.runtime.reason = "process_running";
  orchestratorLifecycle.runtime.lastObservedAt = createdAt.toISOString();
  orchestratorLifecycle.runtime.handle = {
    id: orchestratorTmuxName,
    runtimeName: "tmux",
    data: {},
  };
  orchestratorLifecycle.runtime.tmuxName = orchestratorTmuxName;

  writeMetadata(sessionsDir, ORCHESTRATOR_ID, {
    worktree: join(rootDir, "orchestrator-worktree"),
    branch: "orchestrator/todo-orchestrator",
    status: deriveLegacyStatus(orchestratorLifecycle),
    lifecycle: orchestratorLifecycle,
    role: "orchestrator",
    project: PROJECT_ID,
    displayName: "# Todo App Orchestrator",
    agent: "codex",
    createdAt: createdAt.toISOString(),
    tmuxName: orchestratorTmuxName,
    runtimeHandle: { id: orchestratorTmuxName, runtimeName: "tmux", data: {} },
  });

  const store = createCodeReviewStore(PROJECT_ID);
  store.deleteAll();
  store.createRun({
    linkedSessionId: SESSION_ID,
    reviewerSessionId: "todo-rev-failed",
    status: "failed",
    prNumber: 1,
    prUrl: PR_URL,
    summary: "Seeded failed run for retry coverage.",
  });

  return {
    rootDir,
    homeDir,
    projectDir,
    globalConfigPath,
    localConfigPath,
    tmuxSessionPrefix,
    tmuxSessions: [workerTmuxName, orchestratorTmuxName],
  };
}

function reviewCard(page: Page, reviewerSessionId: string): Locator {
  return page.locator(`[data-reviewer-session-id="${reviewerSessionId}"]`);
}

function projectAoDir(fixture: Fixture): string {
  return join(fixture.homeDir, ".agent-orchestrator", "projects", PROJECT_ID);
}

function runAoCli(fixture: Fixture, args: string[]): string {
  return execFileSync("pnpm", ["--dir", join(REPO_ROOT, "packages/cli"), "dev", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: fixture.homeDir,
      AO_GLOBAL_CONFIG: fixture.globalConfigPath,
      AO_CONFIG_PATH: fixture.localConfigPath,
      AO_NO_UPDATE_NOTIFIER: "1",
      AGENT_ORCHESTRATOR_CI: "1",
    },
  });
}

function runAoCliAsync(fixture: Fixture, args: string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("pnpm", ["--dir", join(REPO_ROOT, "packages/cli"), "dev", ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: fixture.homeDir,
        AO_GLOBAL_CONFIG: fixture.globalConfigPath,
        AO_CONFIG_PATH: fixture.localConfigPath,
        AO_NO_UPDATE_NOTIFIER: "1",
        AGENT_ORCHESTRATOR_CI: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun(stdout);
        return;
      }
      rejectRun(new Error(`ao ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function orchestratorReviewRun(fixture: Fixture, args: string[]): unknown {
  return parseJsonCommandOutput(runAoCli(fixture, ["review", "run", SESSION_ID, ...args]));
}

function orchestratorReviewExecute(fixture: Fixture, args: string[]): unknown {
  return parseJsonCommandOutput(runAoCli(fixture, ["review", "execute", PROJECT_ID, ...args]));
}

async function orchestratorReviewExecuteAsync(
  fixture: Fixture,
  args: string[],
): Promise<unknown> {
  return parseJsonCommandOutput(
    await runAoCliAsync(fixture, ["review", "execute", PROJECT_ID, ...args]),
  );
}

function parseJsonCommandOutput(output: string): unknown {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line || (!line.startsWith("{") && !line.startsWith("["))) continue;
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      // Keep scanning for the actual JSON payload. pnpm can echo JSON-looking command args.
    }
  }

  throw new Error(`Expected JSON command output, received: ${output}`);
}

async function expectVisible(locator: Locator, label: string): Promise<void> {
  try {
    await locator.waitFor({ state: "visible", timeout: 15_000 });
  } catch (error) {
    throw new Error(
      `Expected visible: ${label}\n${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
}

async function clickWorkspaceMode(page: Page, name: "Coding" | "Reviews"): Promise<void> {
  await page
    .getByRole("navigation", { name: "Workspace mode" })
    .getByRole("link", { name, exact: true })
    .click();
}

async function step(name: string, run: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n- ${name}\n`);
  await run();
}

async function main(): Promise<void> {
  const fixture = createFixture();
  installFixtureSignalCleanup(fixture);
  const server = await startWebServer(fixture);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await step("enter the project through its orchestrator", async () => {
      await page.goto(`${server.baseUrl}/projects/${PROJECT_ID}/sessions/${ORCHESTRATOR_ID}`, {
        waitUntil: "networkidle",
      });
      await expectVisible(page.getByText("# Todo App Orchestrator").first(), "orchestrator title");
    });

    await step("navigate between coding and review modes from the shared header", async () => {
      await page.goto(`${server.baseUrl}/projects/${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      const nav = page.getByRole("navigation", { name: "Workspace mode" });
      await expectVisible(nav.getByRole("link", { name: "Coding", exact: true }), "Coding tab");
      assert.equal(
        await nav.getByRole("link", { name: "Coding", exact: true }).getAttribute("aria-current"),
        "page",
      );

      await clickWorkspaceMode(page, "Reviews");
      await page.waitForURL(`**/review?project=${PROJECT_ID}`);
      const reviewNav = page.getByRole("navigation", { name: "Workspace mode" });
      assert.equal(
        await reviewNav
          .getByRole("link", { name: "Reviews", exact: true })
          .getAttribute("aria-current"),
        "page",
      );
      assert.equal(
        await reviewNav.getByRole("link", { name: "Coding", exact: true }).getAttribute("href"),
        `/projects/${PROJECT_ID}`,
      );
    });

    await step("confirm coding and review modes use the same project orchestrator", async () => {
      await page.goto(`${server.baseUrl}/projects/${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      const codingOrchestrator = page.getByRole("link", { name: "Orchestrator" }).first();
      await expectVisible(codingOrchestrator, "coding orchestrator link");
      const codingHref = await codingOrchestrator.getAttribute("href");
      assert.equal(codingHref, `/projects/${PROJECT_ID}/sessions/${ORCHESTRATOR_ID}`);

      await clickWorkspaceMode(page, "Reviews");
      await page.waitForURL(`**/review?project=${PROJECT_ID}`);
      const reviewOrchestrator = page.getByRole("link", { name: "Open project orchestrator" });
      await expectVisible(reviewOrchestrator, "review orchestrator link");
      assert.equal(await reviewOrchestrator.getAttribute("href"), codingHref);
      assert.equal(
        await page.getByRole("button", { name: "Spawn Orchestrator" }).count(),
        0,
        "review board should reuse the existing orchestrator instead of spawning another",
      );
    });

    await step("orchestrator requests the first review", async () => {
      const requested = orchestratorReviewRun(fixture, [
        "--summary",
        "Orchestrator requested initial E2E review",
        "--json",
      ]) as { run: { reviewerSessionId: string; status: string } };
      assert.equal(requested.run.status, "queued");
      assert.equal(requested.run.reviewerSessionId, "todo-rev-1");

      await page.goto(`${server.baseUrl}/review?project=${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      await page.waitForURL(`**/review?project=${PROJECT_ID}`);
      await expectVisible(reviewCard(page, "todo-rev-1"), "todo-rev-1 queued review card");
      await expectVisible(reviewCard(page, "todo-rev-failed"), "seeded failed retry card");
    });

    await step("orchestrator requests another review", async () => {
      const requested = orchestratorReviewRun(fixture, [
        "--summary",
        "Orchestrator requested parallel E2E review",
        "--json",
      ]) as { run: { reviewerSessionId: string; status: string } };
      assert.equal(requested.run.status, "queued");
      assert.equal(requested.run.reviewerSessionId, "todo-rev-2");

      await page.goto(`${server.baseUrl}/review?project=${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      await expectVisible(reviewCard(page, "todo-rev-2"), "todo-rev-2 queued review card");
    });

    await step("orchestrator runs two queued reviewer runs concurrently", async () => {
      const startedAt = Date.now();
      const firstExecution = orchestratorReviewExecuteAsync(fixture, [
        "--run",
        "todo-rev-1",
        "--command",
        buildFindingReviewCommand(8_000),
        "--json",
      ]);
      const secondExecution = orchestratorReviewExecuteAsync(fixture, [
        "--run",
        "todo-rev-2",
        "--command",
        buildFindingReviewCommand(8_000),
        "--json",
      ]);

      const [firstResult, secondResult] = (await Promise.all([
        firstExecution,
        secondExecution,
      ])) as [
        { run: { reviewerSessionId: string; status: string } },
        { run: { reviewerSessionId: string; status: string } },
      ];
      assert.equal(firstResult.run.status, "needs_triage");
      assert.equal(secondResult.run.status, "needs_triage");
      assert.ok(
        Date.now() - startedAt < 14_000,
        "reviewer executions should run concurrently, not serially",
      );

      await page.goto(`${server.baseUrl}/review?project=${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      await expectVisible(
        page.locator('[data-reviewer-session-id="todo-rev-1"][data-review-status="needs_triage"]'),
        "first card in triage",
      );
      await expectVisible(
        page.locator('[data-reviewer-session-id="todo-rev-2"][data-review-status="needs_triage"]'),
        "second card in triage",
      );
    });

    await step("confirm reviewer workspaces stay isolated from coding sessions", async () => {
      const aoProjectDir = projectAoDir(fixture);
      assert.equal(
        existsSync(join(aoProjectDir, "code-reviews", "workspaces", "todo-rev-1")),
        true,
        "executed reviewer run should have a snapshot workspace",
      );
      assert.equal(
        existsSync(join(aoProjectDir, "sessions", "todo-rev-1.json")),
        false,
        "reviewer run must not create coding session metadata",
      );
      await expectVisible(
        reviewCard(page, "todo-rev-1").getByRole("link", { name: "Worker" }),
        "worker link still points at coding worker",
      );
    });

    await step("open findings details from a triage review card", async () => {
      const first = reviewCard(page, "todo-rev-1");
      await first.getByRole("button", { name: "view" }).click();
      const dialog = page.getByRole("dialog", { name: /E2E todo review target/i });
      await expectVisible(dialog, "review details dialog");
      await expectVisible(dialog.getByText("E2E reviewer finding"), "finding title");
      await expectVisible(dialog.getByText("README.md:1"), "finding location");
      await expectVisible(
        dialog.getByText("The e2e review command created this finding."),
        "finding body",
      );
      await expectVisible(dialog.getByRole("link", { name: "Open terminal" }), "terminal link");
      await dialog.getByLabel("Close review details").click();
    });

    await step("review board sends review findings back to the linked worker", async () => {
      await reviewCard(page, "todo-rev-1").getByRole("button", { name: "Feedback" }).click();
      await page.waitForURL(
        `**/projects/${PROJECT_ID}/sessions/${SESSION_ID}#session-terminal-section`,
      );

      await waitForTmuxText(
        fixture.tmuxSessions[0] ?? "",
        /E2E reviewer finding/,
        "worker receives AO-local review finding",
      );

      const store = createCodeReviewStore(PROJECT_ID);
      const sentRun = store
        .listRunSummaries()
        .find((run) => run.reviewerSessionId === "todo-rev-1");
      assert.ok(sentRun, "sent review run should still exist");
      assert.equal(sentRun.status, "waiting_update");
      assert.equal(sentRun.openFindingCount, 0);
      assert.equal(sentRun.sentFindingCount, 1);

      const sentFindings = store.listFindings({ runId: sentRun.id });
      assert.equal(sentFindings.length, 1);
      assert.equal(sentFindings[0]?.status, "sent_to_agent");
      assert.ok(sentFindings[0]?.sentToAgentAt, "sent finding should record handoff time");

      await page.goto(`${server.baseUrl}/review?project=${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      const sentCard = reviewCard(page, "todo-rev-1");
      await expectVisible(
        page.locator('[data-reviewer-session-id="todo-rev-1"][data-review-status="waiting_update"]'),
        "sent review moved to waiting",
      );
      await expectVisible(
        sentCard.getByText(/waiting update · 1 finding · 1 sent/i),
        "sent truth line",
      );
      assert.equal(
        await sentCard.getByRole("button", { name: /open finding/i }).count(),
        0,
        "sent findings should not still be counted as open",
      );
    });

    await step("jump from review card back to the linked coding worker", async () => {
      await reviewCard(page, "todo-rev-1").getByRole("link", { name: "Worker" }).click();
      await page.waitForURL(`**/projects/${PROJECT_ID}?session=${SESSION_ID}`);
      assert.equal(new URL(page.url()).searchParams.get("session"), SESSION_ID);
    });

    await step("orchestrator marks older review runs outdated after a new worker commit", async () => {
      writeFileSync(join(fixture.projectDir, "todo.txt"), "new worker commit\n");
      git(fixture.projectDir, ["add", "todo.txt"]);
      git(fixture.projectDir, ["commit", "-m", "worker update"]);

      const requested = orchestratorReviewRun(fixture, [
        "--summary",
        "Orchestrator requested review after worker update",
        "--json",
      ]) as { run: { reviewerSessionId: string; status: string } };
      assert.equal(requested.run.status, "queued");
      assert.equal(requested.run.reviewerSessionId, "todo-rev-3");

      await page.goto(`${server.baseUrl}/review?project=${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      await expectVisible(reviewCard(page, "todo-rev-3"), "todo-rev-3 queued review card");
      await expectVisible(
        page.locator('[data-reviewer-session-id="todo-rev-1"][data-review-status="outdated"]'),
        "older triage review marked outdated",
      );
      await expectVisible(
        page.locator('[data-reviewer-session-id="todo-rev-2"][data-review-status="outdated"]'),
        "second older triage review marked outdated",
      );
    });

    await step("orchestrator runs a clean review and the UI observes it", async () => {
      const requested = orchestratorReviewRun(fixture, [
        "--summary",
        "Orchestrator requested clean review",
        "--json",
      ]) as { run: { id: string; reviewerSessionId: string; status: string } };
      assert.equal(requested.run.status, "queued");

      const executed = orchestratorReviewExecute(fixture, [
        "--run",
        requested.run.reviewerSessionId,
        "--command",
        buildStaticReviewCommand([]),
        "--json",
      ]) as { run: { reviewerSessionId: string; status: string; findingCount: number } };
      assert.equal(executed.run.status, "clean");
      assert.equal(executed.run.findingCount, 0);

      await page.goto(`${server.baseUrl}/review?project=${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      const cleanCard = reviewCard(page, requested.run.reviewerSessionId);
      await expectVisible(
        cleanCard.locator('[data-review-status="clean"]').or(cleanCard),
        "CLI clean review card",
      );
      await expectVisible(
        page.locator(
          `[data-reviewer-session-id="${requested.run.reviewerSessionId}"][data-review-status="clean"]`,
        ),
        "CLI clean review in clean column",
      );
      await expectVisible(cleanCard.getByText(/clean · 0 findings/i), "clean truth line");
      await cleanCard.getByRole("button", { name: "details" }).click();
      const dialog = page.getByRole("dialog", { name: /E2E todo review target/i });
      await expectVisible(dialog.getByText("No findings captured for this run."), "clean details");
      await dialog.getByLabel("Close review details").click();
    });

    await step("orchestrator retries a failed reviewer run", async () => {
      const failed = reviewCard(page, "todo-rev-failed");
      await page.goto(`${server.baseUrl}/review?project=${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      await expectVisible(failed, "failed review card");
      const retryPayload = orchestratorReviewExecute(fixture, [
        "--run",
        "todo-rev-failed",
        "--force",
        "--command",
        buildFindingReviewCommand(0),
        "--json",
      ]) as { run: { status?: string; terminationReason?: string } };
      assert.notEqual(
        retryPayload.run.status,
        "failed",
        retryPayload.run.terminationReason ?? "retry should not fail",
      );
      await page.goto(`${server.baseUrl}/review?project=${PROJECT_ID}`, {
        waitUntil: "networkidle",
      });
      await expectVisible(
        page.locator(
          '[data-reviewer-session-id="todo-rev-failed"][data-review-status="needs_triage"]',
        ),
        "failed card moved to triage after retry",
      );
    });

    await step("confirm review cards expose worker and orchestrator affordances", async () => {
      await page.goto(`${server.baseUrl}/review?project=${PROJECT_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const retried = reviewCard(page, "todo-rev-failed");
      await expectVisible(retried.getByRole("button", { name: "Feedback" }), "feedback button");
      const orchestrator = page.getByRole("link", { name: "Open project orchestrator" });
      await expectVisible(orchestrator, "project orchestrator link");
      assert.equal(
        await orchestrator.getAttribute("href"),
        `/projects/${PROJECT_ID}/sessions/${ORCHESTRATOR_ID}`,
      );
    });

    process.stdout.write("\nReview board e2e flows passed.\n");
  } finally {
    try {
      await browser.close();
    } catch {
      // Best effort cleanup; tmux sessions and fixture files still need cleanup.
    }
    try {
      await server.stop();
    } catch {
      // Best effort cleanup; tmux sessions and fixture files still need cleanup.
    }
    killReviewBoardTmuxSessions(fixture);
    if (process.env["AO_E2E_KEEP_ARTIFACTS"] !== "1") {
      rmSync(fixture.rootDir, { recursive: true, force: true });
    } else {
      process.stdout.write(`\nKept e2e fixture at ${fixture.rootDir}\n`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
