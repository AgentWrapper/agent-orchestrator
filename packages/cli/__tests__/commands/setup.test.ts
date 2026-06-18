import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any imports that use them
// ---------------------------------------------------------------------------

const { mockFindConfigFile } = vi.hoisted(() => ({
  mockFindConfigFile: vi.fn(),
}));

const {
  mockReadFileSync,
  mockWriteFileSync,
  mockExistsSync,
  mockMkdirSync,
  mockCpSync,
  mockRmSync,
} = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockCpSync: vi.fn(),
  mockRmSync: vi.fn(),
}));

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

const { mockProbeGateway, mockValidateToken, mockDetectOpenClawInstallation } = vi.hoisted(() => ({
  mockProbeGateway: vi.fn(),
  mockValidateToken: vi.fn(),
  mockDetectOpenClawInstallation: vi.fn(),
}));

const {
  mockComposioConstructorOptions,
  mockAuthConfigsList,
  mockAuthConfigsCreate,
  mockAuthConfigsRetrieve,
  mockConnectedAccountsList,
  mockConnectedAccountsGet,
  mockConnectedAccountsLink,
  mockConnectedAccountsInitiate,
  mockConnectedAccountsWaitForConnection,
  mockToolkitsAuthorize,
} = vi.hoisted(() => ({
  mockComposioConstructorOptions: [] as Array<Record<string, unknown>>,
  mockAuthConfigsList: vi.fn(),
  mockAuthConfigsCreate: vi.fn(),
  mockAuthConfigsRetrieve: vi.fn(),
  mockConnectedAccountsList: vi.fn(),
  mockConnectedAccountsGet: vi.fn(),
  mockConnectedAccountsLink: vi.fn(),
  mockConnectedAccountsInitiate: vi.fn(),
  mockConnectedAccountsWaitForConnection: vi.fn(),
  mockToolkitsAuthorize: vi.fn(),
}));

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

const { mockClack } = vi.hoisted(() => ({
  mockClack: {
    cancel: vi.fn(),
    confirm: vi.fn(),
    intro: vi.fn(),
    isCancel: vi.fn(),
    log: Object.assign(vi.fn(), { success: vi.fn(), warn: vi.fn() }),
    outro: vi.fn(),
    password: vi.fn(),
    select: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    text: vi.fn(),
  },
}));

function testHttpsUrl(hostParts: string[], path: string): string {
  return `https://${hostParts.join(".")}${path}`;
}

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

const EXAMPLE_WEBHOOK_URL = testHttpsUrl(["example", "com"], "/ao-events");
const NEW_EXAMPLE_WEBHOOK_URL = testHttpsUrl(["new", "example", "com"], "/ao-events");
const SLACK_SECRET_WEBHOOK_URL = testHttpsUrl(
  ["hooks", "slack", "com"],
  "/services/T000/B000/secret",
);
const SLACK_BAD_WEBHOOK_URL = testHttpsUrl(["hooks", "slack", "com"], "/services/T000/B000/bad");
const SLACK_NEW_WEBHOOK_URL = testHttpsUrl(["hooks", "slack", "com"], "/services/TNEW/BNEW/new");

vi.mock("@aoagents/ao-core", () => ({
  CONFIG_SCHEMA_URL:
    "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json",
  DEFAULT_DASHBOARD_NOTIFICATION_LIMIT: 50,
  findConfigFile: (...args: unknown[]) => mockFindConfigFile(...args),
  getDashboardNotificationStorePath: (configPath: string) =>
    `${configPath}.dashboard-notifications.jsonl`,
  isCanonicalGlobalConfigPath: (configPath: string | undefined) =>
    configPath === join(homedir(), ".agent-orchestrator", "config.yaml"),
  normalizeDashboardNotificationLimit: (value: unknown) => {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim().length > 0
          ? Number.parseInt(value, 10)
          : 50;
    return Number.isFinite(parsed) ? Math.min(500, Math.max(1, Math.floor(parsed))) : 50;
  },
  readDashboardNotificationsFromFile: () => [],
  recordActivityEvent: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    cpSync: (...args: unknown[]) => mockCpSync(...args),
    rmSync: (...args: unknown[]) => mockRmSync(...args),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

vi.mock("../../src/lib/openclaw-probe.js", () => ({
  probeGateway: (...args: unknown[]) => mockProbeGateway(...args),
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
  detectOpenClawInstallation: (...args: unknown[]) => mockDetectOpenClawInstallation(...args),
  DEFAULT_OPENCLAW_URL: "http://127.0.0.1:18789",
  HOOKS_PATH: "/hooks/agent",
}));

vi.mock("@composio/core", () => {
  function MockComposio(opts: Record<string, unknown>) {
    mockComposioConstructorOptions.push(opts);
    return {
      authConfigs: {
        list: mockAuthConfigsList,
        create: mockAuthConfigsCreate,
        get: mockAuthConfigsRetrieve,
        retrieve: mockAuthConfigsRetrieve,
      },
      connectedAccounts: {
        list: mockConnectedAccountsList,
        get: mockConnectedAccountsGet,
        link: mockConnectedAccountsLink,
        initiate: mockConnectedAccountsInitiate,
        waitForConnection: mockConnectedAccountsWaitForConnection,
      },
      toolkits: {
        authorize: mockToolkitsAuthorize,
      },
    };
  }
  return { Composio: MockComposio };
});

vi.mock("@clack/prompts", () => mockClack);

import { recordActivityEvent } from "@aoagents/ao-core";
import { registerSetup } from "../../src/commands/setup.js";
import { applyNotifierRoutingPreset } from "../../src/lib/notifier-routing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG = `
port: 3000
defaults: {}
projects:
  my-app:
    name: my-app
    repo: owner/repo
    path: ~/code/my-app
`;

const CONFIG_WITH_OPENCLAW = `
port: 3000
defaults:
  notifiers:
    - openclaw
notifiers:
  openclaw:
    plugin: openclaw
    url: http://127.0.0.1:18789/hooks/agent
    token: "\${OPENCLAW_HOOKS_TOKEN}"
projects:
  my-app:
    name: my-app
`;

function createProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit
  registerSetup(program);
  return program;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notifier routing helpers", () => {
  it("keeps explicit empty priority routes empty unless the preset includes that priority", () => {
    const rawConfig: Record<string, unknown> = {
      defaults: { notifiers: ["slack"] },
      notificationRouting: {
        urgent: [],
        action: ["slack"],
        warning: [],
      },
    };

    applyNotifierRoutingPreset(rawConfig, "desktop", "urgent-action");

    expect(rawConfig["notificationRouting"]).toEqual({
      urgent: ["desktop"],
      action: ["slack", "desktop"],
      warning: [],
      info: ["slack"],
    });
  });

  it("uses defaults only when a priority route is missing", () => {
    const rawConfig: Record<string, unknown> = {
      defaults: { notifiers: ["slack"] },
      notificationRouting: {
        urgent: ["pager"],
      },
    };

    applyNotifierRoutingPreset(rawConfig, "desktop", "urgent-only");

    expect(rawConfig["notificationRouting"]).toEqual({
      urgent: ["pager", "desktop"],
      action: ["slack"],
      warning: ["slack"],
      info: ["slack"],
    });
  });
});

describe("setup dashboard command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
    mockReadFileSync.mockReturnValue(MINIMAL_CONFIG);
    mockWriteFileSync.mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes dashboard notifier config with the urgent-action routing default", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "dashboard",
      "--non-interactive",
      "--limit",
      "75",
    ]);

    const written = String(mockWriteFileSync.mock.calls[0][1]);
    const parsed = parseYaml(written) as {
      notifiers?: Record<string, { plugin?: string; limit?: number }>;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["dashboard"]).toEqual({ plugin: "dashboard", limit: 75 });
    expect(parsed.notificationRouting?.urgent).toContain("dashboard");
    expect(parsed.notificationRouting?.action).toContain("dashboard");
    expect(parsed.notificationRouting?.warning ?? []).not.toContain("dashboard");
    expect(parsed.notificationRouting?.info ?? []).not.toContain("dashboard");
  });

  it("prints status without mutating config", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "dashboard", "--status"]);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("setup composio command", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    mockComposioConstructorOptions.length = 0;
    mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
    mockReadFileSync.mockReturnValue(MINIMAL_CONFIG);
    mockWriteFileSync.mockImplementation(() => {});
    mockAuthConfigsList.mockResolvedValue({
      items: [{ id: "auth_slack_123", toolkit: { slug: "slack" } }],
    });
    mockAuthConfigsCreate.mockResolvedValue({
      id: "auth_slack_created",
      toolkit: { slug: "slack" },
    });
    mockAuthConfigsRetrieve.mockResolvedValue({
      id: "auth_slack_123",
      toolkit: { slug: "slack" },
      toolAccessConfig: {},
    });
    mockConnectedAccountsList.mockResolvedValue({
      items: [
        {
          id: "ca_slack_123",
          status: "ACTIVE",
          toolkit: { slug: "slack" },
          isDisabled: false,
        },
      ],
    });
    mockConnectedAccountsGet.mockImplementation((id: string) => {
      const toolkit = id.includes("discord")
        ? "discordbot"
        : id.includes("gmail")
          ? "gmail"
          : "slack";
      return Promise.resolve({
        id,
        status: "ACTIVE",
        toolkit: { slug: toolkit },
        isDisabled: false,
      });
    });
    mockConnectedAccountsWaitForConnection.mockResolvedValue({
      id: "ca_waited",
      status: "ACTIVE",
      toolkit: { slug: "slack" },
      isDisabled: false,
    });
    mockConnectedAccountsLink.mockResolvedValue({
      id: "conn_req_123",
      redirectUrl: "https://composio.dev/connect/slack",
      waitForConnection: vi.fn().mockResolvedValue({
        id: "ca_authorized",
        status: "ACTIVE",
        toolkit: { slug: "slack" },
        isDisabled: false,
      }),
    });
    mockConnectedAccountsInitiate.mockResolvedValue({
      id: "ca_discord_123",
      status: "ACTIVE",
    });
    mockToolkitsAuthorize.mockResolvedValue({
      id: "conn_req_123",
      redirectUrl: "https://composio.dev/connect/slack",
      waitForConnection: vi.fn().mockResolvedValue({
        id: "ca_authorized",
        status: "ACTIVE",
        toolkit: { slug: "slack" },
        isDisabled: false,
      }),
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue({ id: "1234567890", name: "general" }),
    });
    vi.stubGlobal("fetch", mockFetch);
    for (const fn of Object.values(mockClack)) fn.mockReset();
    mockClack.confirm.mockResolvedValue(true);
    mockClack.isCancel.mockReturnValue(false);
    mockClack.password.mockResolvedValue("ak_interactive");
    mockClack.select.mockResolvedValue("slack");
    mockClack.text.mockResolvedValue("");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("registers the composio setup command", () => {
    const program = createProgram();
    const setup = program.commands.find((command) => command.name() === "setup");
    expect(setup?.commands.some((command) => command.name() === "composio")).toBe(true);
    expect(setup?.commands.some((command) => command.name() === "composio-slack")).toBe(true);
    expect(setup?.commands.some((command) => command.name() === "composio-discord")).toBe(true);
    expect(setup?.commands.some((command) => command.name() === "composio-discord-bot")).toBe(true);
    expect(setup?.commands.some((command) => command.name() === "composio-mail")).toBe(true);
  });

  it("runs the interactive Composio hub and writes Slack config", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select
      .mockResolvedValueOnce("slack")
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("choose-active")
      .mockResolvedValueOnce("ca_slack_123")
      .mockResolvedValueOnce("change")
      .mockResolvedValueOnce("write");
    mockClack.password.mockResolvedValueOnce("ak_interactive");
    mockClack.text.mockResolvedValueOnce("iamasx");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockClack.intro).toHaveBeenCalledWith("AO Composio notifier setup");
    expect(mockClack.select).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: "Which Composio app do you want to configure?",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "slack" }),
          expect.objectContaining({ value: "discord-webhook" }),
          expect.objectContaining({ value: "discord-bot" }),
          expect.objectContaining({ value: "gmail" }),
        ]),
      }),
    );
    expect(mockComposioConstructorOptions).toEqual([{ apiKey: "ak_interactive" }]);
    expect(mockConnectedAccountsList).toHaveBeenCalledWith({
      userIds: ["aoagent"],
      toolkitSlugs: ["slack"],
      statuses: ["ACTIVE"],
      limit: 25,
    });

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["composio"]).toMatchObject({
      plugin: "composio",
      defaultApp: "slack",
      composioApiKey: "ak_interactive",
      userId: "aoagent",
      channelName: "iamasx",
      connectedAccountId: "ca_slack_123",
    });
    expect(parsed.defaults?.notifiers).toContain("composio");
    expect(parsed.notificationRouting?.["urgent"]).toContain("composio");
  });

  it("interactive Slack setup can generate a Composio connect link", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockConnectedAccountsList.mockResolvedValue({ items: [] });
    mockClack.select
      .mockResolvedValueOnce("slack")
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("create-link")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("write");
    mockClack.password.mockResolvedValueOnce("ak_interactive");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockAuthConfigsList).toHaveBeenCalledWith({ toolkit: "slack" });
    expect(mockConnectedAccountsLink).toHaveBeenCalledWith("aoagent", "auth_slack_123", {
      allowMultiple: true,
    });
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenYaml).toContain("connectedAccountId: ca_authorized");
  });

  it("interactive Slack setup shows navigation after an unfinished connect link", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockConnectedAccountsLink.mockResolvedValueOnce({
      id: "conn_req_123",
      redirectUrl: "https://composio.dev/connect/slack",
      waitForConnection: vi.fn().mockResolvedValue(null),
    });
    mockClack.select
      .mockResolvedValueOnce("slack")
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("create-link")
      .mockResolvedValueOnce("check-active")
      .mockResolvedValueOnce("ca_slack_123")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("write");
    mockClack.password.mockResolvedValueOnce("ak_interactive");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "After opening the Composio Slack connect link, what do you want to do?",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "check-active" }),
          expect.objectContaining({ value: "retry-link" }),
          expect.objectContaining({ value: "enter-id" }),
          expect.objectContaining({ value: "back" }),
          expect.objectContaining({ value: "cancel" }),
        ]),
      }),
    );
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenYaml).toContain("connectedAccountId: ca_slack_123");
  });

  it("runs the interactive Composio hub and writes Discord webhook config", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select
      .mockResolvedValueOnce("discord-webhook")
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("enter-url")
      .mockResolvedValueOnce("create-account")
      .mockResolvedValueOnce("urgent-action")
      .mockResolvedValueOnce("write");
    mockClack.password.mockResolvedValueOnce("ak_interactive");
    mockClack.text.mockResolvedValueOnce(
      "https://discord.com/api/webhooks/1234567890/webhook-token",
    );
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockAuthConfigsCreate).toHaveBeenCalledWith("discordbot", {
      type: "use_custom_auth",
      name: "Discord Webhook Auth Config",
      authScheme: "BEARER_TOKEN",
      credentials: { token: "webhook-token" },
    });
    expect(mockConnectedAccountsLink).not.toHaveBeenCalled();
    expect(mockConnectedAccountsInitiate).toHaveBeenCalled();
    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to configure the Composio Discord webhook connected account?",
      }),
    );

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["composio"]).toMatchObject({
      plugin: "composio",
      defaultApp: "discord",
      mode: "webhook",
      webhookUrl: "https://discord.com/api/webhooks/1234567890/webhook-token",
      userId: "aoagent",
      toolVersion: "20260429_01",
      composioApiKey: "ak_interactive",
      connectedAccountId: "ca_discord_123",
    });
    expect(parsed.notifiers?.["composio-discord"]).toBeUndefined();
    expect(parsed.defaults?.notifiers).toContain("composio");
    expect(parsed.notificationRouting?.["urgent"]).toContain("composio");
  });

  it("interactive Discord webhook setup can reuse existing config", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockReadFileSync.mockReturnValue(`
notifiers:
  composio:
    plugin: composio
    defaultApp: discord
    mode: webhook
    composioApiKey: ak_existing
    userId: ao-existing
    webhookUrl: https://discord.com/api/webhooks/old/webhook-token
    connectedAccountId: ca_discord_existing
projects:
  my-app:
    name: my-app
`);
    mockClack.select
      .mockResolvedValueOnce("discord-webhook")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("urgent-action")
      .mockResolvedValueOnce("write");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockConnectedAccountsGet).toHaveBeenCalledWith("ca_discord_existing");
    expect(mockConnectedAccountsInitiate).not.toHaveBeenCalled();
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio"]).toMatchObject({
      webhookUrl: "https://discord.com/api/webhooks/old/webhook-token",
      userId: "ao-existing",
      connectedAccountId: "ca_discord_existing",
    });
  });

  it("interactive Discord webhook setup can show creation steps before URL entry", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select
      .mockResolvedValueOnce("discord-webhook")
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("show-steps")
      .mockResolvedValueOnce("enter-url")
      .mockResolvedValueOnce("create-account")
      .mockResolvedValueOnce("urgent-action")
      .mockResolvedValueOnce("write");
    mockClack.password.mockResolvedValueOnce("ak_interactive");
    mockClack.text.mockResolvedValueOnce("https://discord.com/api/webhooks/222/webhook-token");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "After creating the Discord webhook, what do you want to do?",
      }),
    );
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenYaml).toContain("webhookUrl: https://discord.com/api/webhooks/222/webhook-token");
    expect(writtenYaml).toContain("connectedAccountId: ca_discord_123");
    expect(mockConnectedAccountsLink).not.toHaveBeenCalled();
  });

  it("interactive Discord webhook setup replaces the canonical Composio notifier and clears stale app fields", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockReadFileSync.mockReturnValue(`
notifiers:
  composio:
    plugin: composio
    defaultApp: slack
    composioApiKey: ak_existing
    userId: ao-existing
    channelName: agents
    connectedAccountId: ca_slack_old
    emailTo: old@example.com
projects:
  my-app:
    name: my-app
`);
    mockClack.select
      .mockResolvedValueOnce("discord-webhook")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("enter-url")
      .mockResolvedValueOnce("create-account")
      .mockResolvedValueOnce("urgent-action")
      .mockResolvedValueOnce("write");
    mockClack.text.mockResolvedValueOnce("https://discord.com/api/webhooks/333/webhook-token");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, Record<string, unknown>>;
      defaults?: { notifiers?: string[] };
    };
    expect(parsed.notifiers?.["composio"]).toMatchObject({
      plugin: "composio",
      defaultApp: "discord",
      mode: "webhook",
      webhookUrl: "https://discord.com/api/webhooks/333/webhook-token",
      userId: "ao-existing",
      connectedAccountId: "ca_discord_123",
    });
    expect(parsed.notifiers?.["composio"]?.channelName).toBeUndefined();
    expect(parsed.notifiers?.["composio"]?.emailTo).toBeUndefined();
    expect(parsed.defaults?.notifiers).toContain("composio");
  });

  it("interactive Discord bot setup creates a connected account and writes the canonical Composio notifier", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    process.env.DISCORD_BOT_TOKEN = "";
    mockReadFileSync.mockReturnValue(`
notifiers:
  composio:
    plugin: composio
    defaultApp: discord
    mode: webhook
    composioApiKey: ak_existing
    userId: ao-existing
    webhookUrl: https://discord.com/api/webhooks/old/webhook-token
    channelName: stale-channel
    emailTo: old@example.com
projects:
  my-app:
    name: my-app
`);
    mockAuthConfigsCreate.mockResolvedValueOnce({
      id: "auth_discord_created",
      toolkit: { slug: "discordbot" },
    });
    mockClack.select
      .mockResolvedValueOnce("discord-bot")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("enter-id")
      .mockResolvedValueOnce("create-account")
      .mockResolvedValueOnce("write");
    mockClack.text.mockResolvedValueOnce("1234567890");
    mockClack.password.mockResolvedValueOnce("bot-token");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockFetch).toHaveBeenCalledWith("https://discord.com/api/v10/channels/1234567890", {
      headers: {
        Authorization: "Bot bot-token",
      },
    });
    expect(mockAuthConfigsCreate).toHaveBeenCalledWith("discordbot", {
      type: "use_custom_auth",
      name: "Discord Bot Auth Config",
      authScheme: "BEARER_TOKEN",
      credentials: { token: "bot-token" },
    });
    expect(mockConnectedAccountsInitiate).toHaveBeenCalledWith(
      "ao-existing",
      "auth_discord_created",
      {
        allowMultiple: true,
        config: {
          authScheme: "BEARER_TOKEN",
          val: {
            status: "ACTIVE",
            token: "bot-token",
          },
        },
      },
    );

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, Record<string, unknown>>;
      defaults?: { notifiers?: string[] };
    };
    expect(parsed.notifiers?.["composio"]).toMatchObject({
      plugin: "composio",
      defaultApp: "discord",
      mode: "bot",
      channelId: "1234567890",
      userId: "ao-existing",
      connectedAccountId: "ca_discord_123",
      toolVersion: "20260429_01",
    });
    expect(parsed.notifiers?.["composio"]?.webhookUrl).toBeUndefined();
    expect(parsed.notifiers?.["composio"]?.channelName).toBeUndefined();
    expect(parsed.notifiers?.["composio"]?.emailTo).toBeUndefined();
    expect(writtenYaml).not.toContain("bot-token");
    expect(parsed.defaults?.notifiers).toContain("composio");
  });

  it("interactive Discord bot setup reuses an existing connected account", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockReadFileSync.mockReturnValue(`
notifiers:
  composio:
    plugin: composio
    defaultApp: discord
    mode: bot
    composioApiKey: ak_existing
    userId: ao-existing
    channelId: "1234567890"
    connectedAccountId: ca_discord_existing
projects:
  my-app:
    name: my-app
`);
    mockConnectedAccountsGet.mockResolvedValueOnce({
      id: "ca_discord_existing",
      status: "ACTIVE",
      toolkit: { slug: "discordbot" },
      isDisabled: false,
    });
    mockClack.select
      .mockResolvedValueOnce("discord-bot")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("write");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockConnectedAccountsGet).toHaveBeenCalledWith("ca_discord_existing");
    expect(mockAuthConfigsCreate).not.toHaveBeenCalled();
    expect(mockConnectedAccountsInitiate).not.toHaveBeenCalled();
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio"]).toMatchObject({
      defaultApp: "discord",
      mode: "bot",
      channelId: "1234567890",
      connectedAccountId: "ca_discord_existing",
      userId: "ao-existing",
    });
  });

  it("interactive Gmail setup chooses an active account and writes the canonical Composio notifier", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockReadFileSync.mockReturnValue(`
notifiers:
  composio:
    plugin: composio
    defaultApp: discord
    mode: webhook
    composioApiKey: ak_existing
    userId: ao-existing
    webhookUrl: https://discord.com/api/webhooks/old/webhook-token
    channelName: stale-channel
projects:
  my-app:
    name: my-app
`);
    mockConnectedAccountsList.mockResolvedValueOnce({
      items: [
        {
          id: "ca_gmail_123",
          status: "ACTIVE",
          toolkit: { slug: "gmail" },
          isDisabled: false,
        },
      ],
    });
    mockConnectedAccountsGet.mockResolvedValue({
      id: "ca_gmail_123",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      isDisabled: false,
      data: {
        scope:
          "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata",
      },
    });
    mockClack.select
      .mockResolvedValueOnce("gmail")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("enter-email")
      .mockResolvedValueOnce("choose-active")
      .mockResolvedValueOnce("ca_gmail_123")
      .mockResolvedValueOnce("write");
    mockClack.text.mockResolvedValueOnce("admin@example.com");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockConnectedAccountsList).toHaveBeenCalledWith({
      userIds: ["ao-existing"],
      toolkitSlugs: ["gmail"],
      statuses: ["ACTIVE"],
      limit: 25,
    });
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio"]).toMatchObject({
      plugin: "composio",
      defaultApp: "gmail",
      emailTo: "admin@example.com",
      userId: "ao-existing",
      connectedAccountId: "ca_gmail_123",
      toolVersion: "20260506_01",
    });
    expect(parsed.notifiers?.["composio"]?.mode).toBeUndefined();
    expect(parsed.notifiers?.["composio"]?.webhookUrl).toBeUndefined();
    expect(parsed.notifiers?.["composio"]?.channelName).toBeUndefined();
    expect(parsed.defaults?.notifiers).toContain("composio");
  });

  it("interactive Gmail setup reuses an existing connected account", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockReadFileSync.mockReturnValue(`
notifiers:
  composio:
    plugin: composio
    defaultApp: gmail
    composioApiKey: ak_existing
    userId: ao-existing
    emailTo: admin@example.com
    connectedAccountId: ca_gmail_existing
projects:
  my-app:
    name: my-app
`);
    mockConnectedAccountsGet.mockResolvedValue({
      id: "ca_gmail_existing",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      isDisabled: false,
      data: {
        scope:
          "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata",
      },
    });
    mockClack.select
      .mockResolvedValueOnce("gmail")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("write");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockConnectedAccountsGet).toHaveBeenCalledWith("ca_gmail_existing");
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio"]).toMatchObject({
      defaultApp: "gmail",
      emailTo: "admin@example.com",
      connectedAccountId: "ca_gmail_existing",
      userId: "ao-existing",
    });
  });

  it("interactive Gmail setup can generate a connect link from an existing auth config", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockAuthConfigsList.mockResolvedValueOnce({
      items: [
        {
          id: "auth_gmail_send",
          toolkit: { slug: "gmail" },
          toolAccessConfig: {
            toolsForConnectedAccountCreation: ["GMAIL_SEND_EMAIL"],
          },
        },
      ],
    });
    mockConnectedAccountsLink.mockResolvedValueOnce({
      id: "conn_req_gmail",
      redirectUrl: "https://connect.composio.dev/link/lk_gmail",
      waitForConnection: vi.fn().mockResolvedValue({
        id: "ca_gmail_authorized",
        status: "ACTIVE",
        toolkit: { slug: "gmail" },
        isDisabled: false,
      }),
    });
    mockConnectedAccountsGet.mockResolvedValue({
      id: "ca_gmail_authorized",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      isDisabled: false,
      data: {
        scope:
          "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata",
      },
    });
    mockClack.select
      .mockResolvedValueOnce("gmail")
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("enter-email")
      .mockResolvedValueOnce("create-link")
      .mockResolvedValueOnce("choose-existing")
      .mockResolvedValueOnce("auth_gmail_send")
      .mockResolvedValueOnce("write");
    mockClack.text.mockResolvedValueOnce("admin@example.com");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio"]);

    expect(mockAuthConfigsCreate).not.toHaveBeenCalledWith("gmail", expect.anything());
    expect(mockConnectedAccountsLink).toHaveBeenCalledWith("aoagent", "auth_gmail_send", {
      allowMultiple: true,
    });
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenYaml).toContain("connectedAccountId: ca_gmail_authorized");
    expect(writtenYaml).toContain("emailTo: admin@example.com");
  });

  it("interactive Gmail setup rejects accounts without Gmail send access", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockReadFileSync.mockReturnValue(`
notifiers:
  composio:
    plugin: composio
    defaultApp: gmail
    composioApiKey: ak_existing
    userId: ao-existing
    emailTo: admin@example.com
    connectedAccountId: ca_gmail_bad
projects:
  my-app:
    name: my-app
`);
    mockConnectedAccountsGet.mockResolvedValue({
      id: "ca_gmail_bad",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      isDisabled: false,
      data: {
        scope: "openid https://www.googleapis.com/auth/userinfo.email",
      },
    });
    mockAuthConfigsRetrieve.mockResolvedValueOnce(null);
    mockClack.select
      .mockResolvedValueOnce("gmail")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("use-existing")
      .mockResolvedValueOnce("cancel");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = createProgram();

    await expect(program.parseAsync(["node", "test", "setup", "composio"])).rejects.toThrow(
      "process.exit",
    );

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("interactive hub can be cancelled from app choices", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select.mockResolvedValueOnce("cancel");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = createProgram();

    await expect(program.parseAsync(["node", "test", "setup", "composio"])).rejects.toThrow(
      "process.exit",
    );

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("interactive Composio Slack setup writes the dedicated notifier", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("choose-active")
      .mockResolvedValueOnce("ca_slack_123")
      .mockResolvedValueOnce("change")
      .mockResolvedValueOnce("write");
    mockClack.password.mockResolvedValueOnce("ak_interactive");
    mockClack.text.mockResolvedValueOnce("iamasx");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio-slack"]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio-slack"]).toMatchObject({
      plugin: "composio",
      defaultApp: "slack",
      composioApiKey: "ak_interactive",
      userId: "aoagent",
      channelName: "iamasx",
      connectedAccountId: "ca_slack_123",
    });
    expect(parsed.notifiers?.["composio"]).toBeUndefined();
    expect(parsed.defaults?.notifiers).toContain("composio-slack");
  });

  it("preserves an existing custom Composio userId", async () => {
    mockReadFileSync.mockReturnValue(`
notifiers:
  composio-slack:
    plugin: composio
    defaultApp: slack
    userId: existing-user
`);
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio-slack",
      "--api-key",
      "ak_test",
      "--connected-account-id",
      "ca_slack_123",
      "--non-interactive",
    ]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio-slack"]?.["userId"]).toBe("existing-user");
  });

  it("interactive Composio Discord webhook setup writes the dedicated notifier", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("enter-url")
      .mockResolvedValueOnce("create-account")
      .mockResolvedValueOnce("urgent-action")
      .mockResolvedValueOnce("write");
    mockClack.password.mockResolvedValueOnce("ak_interactive");
    mockClack.text.mockResolvedValueOnce(
      "https://discord.com/api/webhooks/1234567890/webhook-token",
    );
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio-discord"]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio-discord"]).toMatchObject({
      plugin: "composio",
      defaultApp: "discord",
      mode: "webhook",
      webhookUrl: "https://discord.com/api/webhooks/1234567890/webhook-token",
      userId: "aoagent",
      connectedAccountId: "ca_discord_123",
    });
    expect(parsed.notifiers?.["composio"]).toBeUndefined();
    expect(parsed.defaults?.notifiers).toContain("composio-discord");
  });

  it("interactive Composio Discord bot setup writes the dedicated notifier", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    process.env.DISCORD_BOT_TOKEN = "";
    mockAuthConfigsCreate.mockResolvedValueOnce({
      id: "auth_discord_created",
      toolkit: { slug: "discordbot" },
    });
    mockClack.select
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("enter-id")
      .mockResolvedValueOnce("create-account")
      .mockResolvedValueOnce("write");
    mockClack.text.mockResolvedValueOnce("1234567890");
    mockClack.password.mockResolvedValueOnce("ak_interactive").mockResolvedValueOnce("bot-token");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio-discord-bot"]);

    expect(mockFetch).toHaveBeenCalledWith("https://discord.com/api/v10/channels/1234567890", {
      headers: {
        Authorization: "Bot bot-token",
      },
    });
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio-discord-bot"]).toMatchObject({
      plugin: "composio",
      defaultApp: "discord",
      mode: "bot",
      channelId: "1234567890",
      userId: "aoagent",
      connectedAccountId: "ca_discord_123",
    });
    expect(writtenYaml).not.toContain("bot-token");
    expect(parsed.defaults?.notifiers).toContain("composio-discord-bot");
  });

  it("interactive Composio mail setup writes the dedicated notifier", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockConnectedAccountsList.mockResolvedValueOnce({
      items: [
        {
          id: "ca_gmail_123",
          status: "ACTIVE",
          toolkit: { slug: "gmail" },
          isDisabled: false,
        },
      ],
    });
    mockConnectedAccountsGet.mockResolvedValue({
      id: "ca_gmail_123",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      isDisabled: false,
      data: {
        scope:
          "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata",
      },
    });
    mockClack.select
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("enter-email")
      .mockResolvedValueOnce("choose-active")
      .mockResolvedValueOnce("ca_gmail_123")
      .mockResolvedValueOnce("write");
    mockClack.password.mockResolvedValueOnce("ak_interactive");
    mockClack.text.mockResolvedValueOnce("admin@example.com");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio-mail"]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio-mail"]).toMatchObject({
      plugin: "composio",
      defaultApp: "gmail",
      emailTo: "admin@example.com",
      userId: "aoagent",
      connectedAccountId: "ca_gmail_123",
    });
    expect(parsed.notifiers?.["composio"]).toBeUndefined();
    expect(parsed.defaults?.notifiers).toContain("composio-mail");
  });

  it("interactive Composio direct app flag writes the canonical notifier", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockConnectedAccountsList.mockResolvedValueOnce({
      items: [
        {
          id: "ca_gmail_123",
          status: "ACTIVE",
          toolkit: { slug: "gmail" },
          isDisabled: false,
        },
      ],
    });
    mockConnectedAccountsGet.mockResolvedValue({
      id: "ca_gmail_123",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      isDisabled: false,
      data: {
        scope:
          "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata",
      },
    });
    mockClack.select
      .mockResolvedValueOnce("enter-new")
      .mockResolvedValueOnce("use-current")
      .mockResolvedValueOnce("enter-email")
      .mockResolvedValueOnce("choose-active")
      .mockResolvedValueOnce("ca_gmail_123")
      .mockResolvedValueOnce("write");
    mockClack.password.mockResolvedValueOnce("ak_interactive");
    mockClack.text.mockResolvedValueOnce("admin@example.com");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "composio", "--gmail"]);

    expect(mockClack.select).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Which Composio app do you want to configure?",
      }),
    );
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio"]).toMatchObject({
      plugin: "composio",
      defaultApp: "gmail",
      emailTo: "admin@example.com",
      connectedAccountId: "ca_gmail_123",
    });
    expect(parsed.notifiers?.["composio-mail"]).toBeUndefined();
    expect(parsed.defaults?.notifiers).toContain("composio");
  });

  it("writes Composio config with a discovered Slack connected account", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio",
      "--api-key",
      "ak_test",
      "--user-id",
      "ao-user",
      "--channel",
      "iamasx",
      "--non-interactive",
    ]);

    expect(mockComposioConstructorOptions).toEqual([{ apiKey: "ak_test" }]);
    expect(mockConnectedAccountsList).toHaveBeenCalledWith({
      userIds: ["ao-user"],
      toolkitSlugs: ["slack"],
      statuses: ["ACTIVE"],
      limit: 25,
    });

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["composio"]).toMatchObject({
      plugin: "composio",
      defaultApp: "slack",
      composioApiKey: "ak_test",
      userId: "ao-user",
      channelName: "iamasx",
      connectedAccountId: "ca_slack_123",
    });
    expect(parsed.defaults?.notifiers).toContain("composio");
    expect(parsed.notificationRouting?.["urgent"]).toContain("composio");
    expect(parsed.notificationRouting?.["action"]).toContain("composio");
    expect(parsed.notificationRouting?.["warning"]).toContain("composio");
    expect(parsed.notificationRouting?.["info"]).toContain("composio");
  });

  it("uses COMPOSIO_API_KEY and does not write the env value to config", async () => {
    process.env.COMPOSIO_API_KEY = "ak_env";
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio",
      "--user-id",
      "ao-user",
      "--non-interactive",
    ]);

    expect(mockComposioConstructorOptions).toEqual([{ apiKey: "ak_env" }]);
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenYaml).not.toContain("ak_env");
  });

  it("verifies and stores an explicit connected account id", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio",
      "--api-key",
      "ak_test",
      "--connected-account-id",
      "ca_explicit",
      "--non-interactive",
    ]);

    expect(mockConnectedAccountsGet).toHaveBeenCalledWith("ca_explicit");
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio"]?.["connectedAccountId"]).toBe("ca_explicit");
  });

  it("fails in non-interactive mode when multiple Slack accounts need selection", async () => {
    mockConnectedAccountsList.mockResolvedValue({
      items: [
        { id: "ca_one", status: "ACTIVE", toolkit: { slug: "slack" } },
        { id: "ca_two", status: "ACTIVE", toolkit: { slug: "slack" } },
      ],
    });
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "composio",
        "--api-key",
        "ak_test",
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("creates a Slack connect request when no active account exists", async () => {
    mockConnectedAccountsList.mockResolvedValue({ items: [] });
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio",
      "--api-key",
      "ak_test",
      "--user-id",
      "ao-user",
      "--wait-ms",
      "1",
      "--non-interactive",
    ]);

    expect(mockAuthConfigsList).toHaveBeenCalledWith({ toolkit: "slack" });
    expect(mockConnectedAccountsLink).toHaveBeenCalledWith("ao-user", "auth_slack_123", {
      allowMultiple: true,
    });
    expect(mockToolkitsAuthorize).not.toHaveBeenCalled();
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenYaml).toContain("connectedAccountId: ca_authorized");
  });

  it("does not write Slack Composio config when a connect request does not complete", async () => {
    mockConnectedAccountsList.mockResolvedValue({ items: [] });
    mockConnectedAccountsLink.mockResolvedValueOnce({
      id: "conn_req_slack",
      redirectUrl: "https://composio.dev/connect/slack",
      waitForConnection: vi.fn().mockResolvedValue(null),
    });
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio",
      "--api-key",
      "ak_test",
      "--user-id",
      "ao-user",
      "--wait-ms",
      "1",
      "--non-interactive",
    ]);

    expect(mockConnectedAccountsLink).toHaveBeenCalledWith("ao-user", "auth_slack_123", {
      allowMultiple: true,
    });
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("creates a Slack auth config before linking when none exists", async () => {
    mockConnectedAccountsList.mockResolvedValue({ items: [] });
    mockAuthConfigsList.mockResolvedValue({ items: [] });
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio",
      "--api-key",
      "ak_test",
      "--user-id",
      "ao-user",
      "--wait-ms",
      "1",
      "--non-interactive",
    ]);

    expect(mockAuthConfigsCreate).toHaveBeenCalledWith("slack", {
      type: "use_composio_managed_auth",
      name: "Slack Auth Config",
    });
    expect(mockConnectedAccountsLink).toHaveBeenCalledWith("ao-user", "auth_slack_created", {
      allowMultiple: true,
    });
  });

  it("shows status without writing config", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio",
      "--api-key",
      "ak_test",
      "--status",
    ]);

    expect(mockConnectedAccountsList).toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("fails on conflicting composio notifier config unless --force is set", async () => {
    mockReadFileSync.mockReturnValue(`
notifiers:
  composio:
    plugin: webhook
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "composio",
        "--api-key",
        "ak_test",
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("writes Composio Discord webhook config with a connected account", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio-discord",
      "--api-key",
      "ak_test",
      "--webhook-url",
      "https://discord.com/api/webhooks/1234567890/webhook-token",
      "--non-interactive",
    ]);

    expect(mockAuthConfigsCreate).toHaveBeenCalledWith("discordbot", {
      type: "use_custom_auth",
      name: "Discord Webhook Auth Config",
      authScheme: "BEARER_TOKEN",
      credentials: { token: "webhook-token" },
    });
    expect(mockConnectedAccountsInitiate).toHaveBeenCalled();

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["composio-discord"]).toMatchObject({
      plugin: "composio",
      defaultApp: "discord",
      mode: "webhook",
      webhookUrl: "https://discord.com/api/webhooks/1234567890/webhook-token",
      userId: "aoagent",
      toolVersion: "20260429_01",
      composioApiKey: "ak_test",
      connectedAccountId: "ca_discord_123",
    });
    expect(parsed.defaults?.notifiers).toContain("composio-discord");
    expect(parsed.notificationRouting?.["urgent"]).toContain("composio-discord");
    expect(writtenYaml).not.toContain("botToken");
  });

  it("writes Composio Discord bot config and does not persist the bot token", async () => {
    mockAuthConfigsCreate.mockResolvedValueOnce({
      id: "auth_discord_created",
      toolkit: { slug: "discordbot" },
    });
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio-discord-bot",
      "--api-key",
      "ak_test",
      "--channel-id",
      "1234567890",
      "--bot-token",
      "bot-token",
      "--non-interactive",
    ]);

    expect(mockFetch).toHaveBeenCalledWith("https://discord.com/api/v10/channels/1234567890", {
      headers: {
        Authorization: "Bot bot-token",
      },
    });
    expect(mockAuthConfigsCreate).toHaveBeenCalledWith("discordbot", {
      type: "use_custom_auth",
      name: "Discord Bot Auth Config",
      authScheme: "BEARER_TOKEN",
      credentials: { token: "bot-token" },
    });
    expect(mockConnectedAccountsInitiate).toHaveBeenCalledWith("aoagent", "auth_discord_created", {
      allowMultiple: true,
      config: {
        authScheme: "BEARER_TOKEN",
        val: {
          status: "ACTIVE",
          token: "bot-token",
        },
      },
    });

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["composio-discord-bot"]).toMatchObject({
      plugin: "composio",
      defaultApp: "discord",
      mode: "bot",
      channelId: "1234567890",
      userId: "aoagent",
      connectedAccountId: "ca_discord_123",
      toolVersion: "20260429_01",
      composioApiKey: "ak_test",
    });
    expect(parsed.defaults?.notifiers).toContain("composio-discord-bot");
    expect(parsed.notificationRouting?.["urgent"]).toContain("composio-discord-bot");
    expect(writtenYaml).not.toContain("bot-token");
  });

  it("fails Discord bot setup when the bot cannot access the channel", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: vi.fn().mockResolvedValue({ message: "Missing Access" }),
    });
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "composio-discord-bot",
        "--api-key",
        "ak_test",
        "--channel-id",
        "1234567890",
        "--bot-token",
        "bot-token",
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("writes Discord bot config from an explicit connected account without a bot token", async () => {
    mockConnectedAccountsGet.mockResolvedValue({
      id: "ca_discord_explicit",
      status: "ACTIVE",
      toolkit: { slug: "discordbot" },
      isDisabled: false,
    });
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio-discord-bot",
      "--api-key",
      "ak_test",
      "--channel-id",
      "1234567890",
      "--connected-account-id",
      "ca_discord_explicit",
      "--non-interactive",
    ]);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockConnectedAccountsInitiate).not.toHaveBeenCalled();
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio-discord-bot"]?.["connectedAccountId"]).toBe(
      "ca_discord_explicit",
    );
  });

  it("writes Composio mail config with a discovered Gmail connected account", async () => {
    mockConnectedAccountsList.mockResolvedValue({
      items: [
        {
          id: "ca_gmail_123",
          status: "ACTIVE",
          toolkit: { slug: "gmail" },
          isDisabled: false,
        },
      ],
    });
    mockConnectedAccountsGet.mockResolvedValue({
      id: "ca_gmail_123",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      isDisabled: false,
      data: {
        scope:
          "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata",
      },
    });
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio-mail",
      "--api-key",
      "ak_test",
      "--user-id",
      "ao-user",
      "--email-to",
      "admin@example.com",
      "--non-interactive",
    ]);

    expect(mockConnectedAccountsList).toHaveBeenCalledWith({
      userIds: ["ao-user"],
      toolkitSlugs: ["gmail"],
      statuses: ["ACTIVE"],
      limit: 25,
    });

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      defaults?: { notifiers?: string[] };
      notifiers?: Record<string, Record<string, unknown>>;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["composio-mail"]).toMatchObject({
      plugin: "composio",
      defaultApp: "gmail",
      emailTo: "admin@example.com",
      userId: "ao-user",
      connectedAccountId: "ca_gmail_123",
      toolVersion: "20260506_01",
      composioApiKey: "ak_test",
    });
    expect(parsed.defaults?.notifiers).toContain("composio-mail");
    expect(parsed.notificationRouting?.["urgent"]).toContain("composio-mail");
  });

  it("fails when no usable Gmail connected account exists", async () => {
    mockConnectedAccountsList.mockResolvedValue({ items: [] });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = createProgram();

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "composio-mail",
        "--api-key",
        "ak_test",
        "--email-to",
        "admin@example.com",
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockAuthConfigsCreate).not.toHaveBeenCalledWith("gmail", expect.anything());
    expect(mockConnectedAccountsLink).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("prints a Gmail connect URL without writing config when --connect does not complete", async () => {
    mockConnectedAccountsList.mockResolvedValue({ items: [] });
    mockAuthConfigsList.mockResolvedValueOnce({
      items: [
        {
          id: "auth_gmail_send",
          toolkit: { slug: "gmail" },
          toolAccessConfig: {
            toolsForConnectedAccountCreation: ["GMAIL_SEND_EMAIL"],
          },
        },
      ],
    });
    mockConnectedAccountsLink.mockResolvedValueOnce({
      id: "conn_req_gmail",
      redirectUrl: "https://connect.composio.dev/link/lk_123",
      waitForConnection: vi.fn().mockResolvedValue(null),
    });
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio-mail",
      "--api-key",
      "ak_test",
      "--email-to",
      "admin@example.com",
      "--connect",
      "--wait-ms",
      "1",
      "--non-interactive",
    ]);

    expect(mockAuthConfigsList).toHaveBeenCalledWith({ toolkit: "gmail" });
    expect(mockConnectedAccountsLink).toHaveBeenCalledWith("aoagent", "auth_gmail_send", {
      allowMultiple: true,
    });
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("writes mail config when --connect completes with a Gmail connected account", async () => {
    mockConnectedAccountsList.mockResolvedValue({ items: [] });
    mockAuthConfigsList.mockResolvedValueOnce({
      items: [
        {
          id: "auth_gmail_send",
          toolkit: { slug: "gmail" },
          toolAccessConfig: {
            toolsForConnectedAccountCreation: ["GMAIL_SEND_EMAIL"],
          },
        },
      ],
    });
    mockConnectedAccountsLink.mockResolvedValueOnce({
      id: "conn_req_gmail",
      redirectUrl: "https://connect.composio.dev/link/lk_123",
      waitForConnection: vi.fn().mockResolvedValue({
        id: "ca_gmail_authorized",
        status: "ACTIVE",
        toolkit: { slug: "gmail" },
        isDisabled: false,
      }),
    });
    mockConnectedAccountsGet.mockResolvedValueOnce({
      id: "ca_gmail_authorized",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      isDisabled: false,
      data: {
        scope:
          "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata",
      },
    });
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio-mail",
      "--api-key",
      "ak_test",
      "--email-to",
      "admin@example.com",
      "--connect",
      "--wait-ms",
      "1",
      "--non-interactive",
    ]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenYaml).toContain("connectedAccountId: ca_gmail_authorized");
  });

  it("uses an explicit Gmail auth config id for --connect", async () => {
    mockConnectedAccountsList.mockResolvedValue({ items: [] });
    mockAuthConfigsRetrieve.mockResolvedValueOnce({
      id: "auth_gmail_custom",
      toolkit: { slug: "gmail" },
      toolAccessConfig: {
        toolsForConnectedAccountCreation: ["GMAIL_SEND_EMAIL"],
      },
    });
    mockConnectedAccountsLink.mockResolvedValueOnce({
      id: "conn_req_gmail",
      redirectUrl: "https://connect.composio.dev/link/lk_custom",
      waitForConnection: vi.fn().mockResolvedValue(null),
    });
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio-mail",
      "--api-key",
      "ak_test",
      "--email-to",
      "admin@example.com",
      "--connect",
      "--auth-config-id",
      "auth_gmail_custom",
      "--wait-ms",
      "1",
      "--non-interactive",
    ]);

    expect(mockAuthConfigsList).not.toHaveBeenCalledWith({ toolkit: "gmail" });
    expect(mockConnectedAccountsLink).toHaveBeenCalledWith("aoagent", "auth_gmail_custom", {
      allowMultiple: true,
    });
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("writes mail config from an explicit Gmail connected account", async () => {
    mockConnectedAccountsGet.mockResolvedValue({
      id: "ca_gmail_explicit",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      isDisabled: false,
      data: {
        scope:
          "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata",
      },
    });
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "composio-mail",
      "--api-key",
      "ak_test",
      "--email-to",
      "admin@example.com",
      "--connected-account-id",
      "ca_gmail_explicit",
      "--non-interactive",
    ]);

    expect(mockConnectedAccountsGet).toHaveBeenCalledWith("ca_gmail_explicit");
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, Record<string, unknown>>;
    };
    expect(parsed.notifiers?.["composio-mail"]?.["connectedAccountId"]).toBe("ca_gmail_explicit");
  });

  it("fails when the existing Gmail account lacks send access and no replacement exists", async () => {
    mockReadFileSync.mockReturnValue(`
notifiers:
  composio-mail:
    plugin: composio
    defaultApp: gmail
    composioApiKey: ak_existing
    emailTo: admin@example.com
    connectedAccountId: ca_gmail_old
projects:
  my-app:
    name: my-app
`);
    mockConnectedAccountsGet.mockResolvedValue({
      id: "ca_gmail_old",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
      isDisabled: false,
      data: {
        scope: "openid https://www.googleapis.com/auth/userinfo.email",
      },
    });
    mockConnectedAccountsList.mockResolvedValue({ items: [] });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = createProgram();

    await expect(
      program.parseAsync(["node", "test", "setup", "composio-mail", "--non-interactive"]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockAuthConfigsCreate).not.toHaveBeenCalledWith("gmail", expect.anything());
    expect(mockConnectedAccountsLink).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("setup openclaw command", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(recordActivityEvent).mockClear();
    mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
    mockReadFileSync.mockReturnValue(MINIMAL_CONFIG);
    mockWriteFileSync.mockImplementation(() => {});
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockImplementation(() => undefined);
    mockValidateToken.mockResolvedValue({ valid: true });
    mockProbeGateway.mockResolvedValue({ reachable: false });

    // Force non-interactive (no TTY in test environment)
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("non-interactive mode", () => {
    it("writes config when --url and --token provided", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "test-token",
        "--non-interactive",
      ]);

      expect(mockWriteFileSync).toHaveBeenCalled();
      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("openclaw");
      expect(writtenYaml).toContain("plugin: openclaw");
      expect(writtenYaml).toContain("http://127.0.0.1:18789/hooks/agent");
      expect(writtenYaml).toContain("token: test-token");
      expect(mockWriteFileSync.mock.calls.some(([path]) => String(path).includes(".zshrc"))).toBe(
        false,
      );
    });

    it("reads token from OPENCLAW_HOOKS_TOKEN env var and skips validation", async () => {
      process.env["OPENCLAW_HOOKS_TOKEN"] = "env-token";
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--non-interactive",
      ]);

      // Non-interactive mode skips pre-write validation
      expect(mockValidateToken).not.toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("${OPENCLAW_HOOKS_TOKEN}");
    });

    it("reads token from OpenClaw config without copying it into AO config", async () => {
      const openclawConfigPath = join(homedir(), ".openclaw", "openclaw.json");
      mockExistsSync.mockImplementation((path: string) => path === openclawConfigPath);
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === "/tmp/agent-orchestrator.yaml") return MINIMAL_CONFIG;
        if (path === openclawConfigPath) {
          return JSON.stringify({ hooks: { token: "openclaw-owned-token" } });
        }
        return "";
      });
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("openclawConfigPath: ~/.openclaw/openclaw.json");
      expect(writtenYaml).not.toContain("openclaw-owned-token");
      expect(mockWriteFileSync.mock.calls).toHaveLength(1);
    });

    it("reads URL from OPENCLAW_GATEWAY_URL env var and skips validation", async () => {
      process.env["OPENCLAW_GATEWAY_URL"] = "http://remote:18789";
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      // Non-interactive mode skips pre-write validation
      expect(mockValidateToken).not.toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it("normalizes OPENCLAW_GATEWAY_URL without double-appending hooks path", async () => {
      process.env["OPENCLAW_GATEWAY_URL"] = "http://remote:18789/hooks/agent";
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("url: http://remote:18789/hooks/agent");
      expect(writtenYaml).not.toContain("/hooks/agent/hooks/agent");
    });

    it("refreshes existing config without requiring --url", async () => {
      process.env["OPENCLAW_HOOKS_TOKEN"] = "env-token";
      mockReadFileSync.mockReturnValue(CONFIG_WITH_OPENCLAW);
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--refresh",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("url: http://127.0.0.1:18789/hooks/agent");
      expect(mockDetectOpenClawInstallation).not.toHaveBeenCalled();
    });

    it("skips token validation and writes config in non-interactive mode", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "good-token",
        "--non-interactive",
      ]);

      // Non-interactive setup skips pre-write validation (gateway may not have
      // the token yet on a fresh install — user restarts gateway after setup)
      expect(mockValidateToken).not.toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe("status", () => {
    it("shows status without writing config", async () => {
      process.env["OPENCLAW_HOOKS_TOKEN"] = "env-token";
      mockReadFileSync.mockReturnValue(CONFIG_WITH_OPENCLAW);
      mockDetectOpenClawInstallation.mockResolvedValue({
        state: "running",
        gatewayUrl: "http://127.0.0.1:18789",
        binaryPath: "/usr/local/bin/openclaw",
        configPath: join(homedir(), ".openclaw", "openclaw.json"),
        probe: { reachable: true, httpStatus: 200 },
      });
      const program = createProgram();

      await program.parseAsync(["node", "test", "setup", "openclaw", "--status"]);

      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockDetectOpenClawInstallation).toHaveBeenCalledWith(
        "http://127.0.0.1:18789/hooks/agent",
      );
      expect(mockValidateToken).toHaveBeenCalledWith(
        "http://127.0.0.1:18789/hooks/agent",
        "env-token",
      );
    });
  });

  describe("config writing", () => {
    it("adds openclaw to defaults.notifiers", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("openclaw");
      expect(writtenYaml).not.toContain("desktop");
    });

    it("does not stamp wrapped config schema onto the canonical global config", async () => {
      mockFindConfigFile.mockReturnValue(join(homedir(), ".agent-orchestrator", "config.yaml"));
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).not.toContain("$schema:");
      expect(writtenYaml).toContain("openclaw");
    });

    it("does not add desktop to defaults.notifiers when initializing notifiers", async () => {
      // Config with no notifiers at all
      mockReadFileSync.mockReturnValue(`
port: 3000
defaults: {}
projects:
  my-app:
    name: my-app
`);
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = parseYaml(writtenYaml) as { defaults?: { notifiers?: string[] } };
      expect(parsed.defaults?.notifiers).not.toContain("desktop");
      expect(parsed.defaults?.notifiers).toContain("openclaw");
    });

    it("does not duplicate openclaw in defaults.notifiers", async () => {
      mockReadFileSync.mockReturnValue(CONFIG_WITH_OPENCLAW);
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = parseYaml(writtenYaml) as { defaults?: { notifiers?: string[] } };
      expect(parsed.defaults?.notifiers?.filter((name) => name === "openclaw")).toHaveLength(1);
    });

    it("preserves defaults and routing when OpenClaw refresh has no routing preset", async () => {
      mockReadFileSync.mockReturnValue(`
port: 3000
defaults:
  notifiers:
    - slack
notifiers:
  slack:
    plugin: slack
  openclaw:
    plugin: openclaw
    url: http://127.0.0.1:18789/hooks/agent
    token: tok
notificationRouting:
  urgent: []
  action:
    - slack
  warning: []
  info:
    - slack
projects:
  my-app:
    name: my-app
`);
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--refresh",
        "--no-test",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = parseYaml(writtenYaml) as {
        defaults?: { notifiers?: string[] };
        notificationRouting?: Record<string, string[]>;
      };
      expect(parsed.defaults?.notifiers).toEqual(["slack"]);
      expect(parsed.notificationRouting).toEqual({
        urgent: [],
        action: ["slack"],
        warning: [],
        info: ["slack"],
      });
    });

    it("writes correct notifier block structure", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://custom:9999/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("plugin: openclaw");
      expect(writtenYaml).toContain("http://custom:9999/hooks/agent");
      expect(writtenYaml).toContain("token: tok");
      expect(writtenYaml).toContain("retries: 3");
      expect(writtenYaml).toContain("retryDelayMs: 1000");
      expect(writtenYaml).toContain("wakeMode: now");
    });

    it("defaults OpenClaw routing to urgent + action only", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = parseYaml(writtenYaml) as {
        notificationRouting?: Record<string, string[]>;
      };

      expect(parsed.notificationRouting?.["urgent"]).toContain("openclaw");
      expect(parsed.notificationRouting?.["action"]).toContain("openclaw");
      expect(parsed.notificationRouting?.["warning"]).not.toContain("openclaw");
      expect(parsed.notificationRouting?.["info"]).not.toContain("openclaw");
    });

    it("supports overriding the routing preset in non-interactive mode", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--routing-preset",
        "all",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = parseYaml(writtenYaml) as {
        notificationRouting?: Record<string, string[]>;
      };

      expect(parsed.notificationRouting?.["urgent"]).toContain("openclaw");
      expect(parsed.notificationRouting?.["action"]).toContain("openclaw");
      expect(parsed.notificationRouting?.["warning"]).toContain("openclaw");
      expect(parsed.notificationRouting?.["info"]).toContain("openclaw");
    });

    it("does not rewrite OpenClaw config when using a token from OpenClaw config", async () => {
      const openclawConfigPath = join(homedir(), ".openclaw", "openclaw.json");

      mockExistsSync.mockImplementation((path: string) => path === openclawConfigPath);
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === "/tmp/agent-orchestrator.yaml") {
          return MINIMAL_CONFIG;
        }
        if (path === openclawConfigPath) {
          return JSON.stringify({
            hooks: {
              enabled: false,
              token: "old-token",
              allowRequestSessionKey: false,
              allowedSessionKeyPrefixes: ["legacy:", "hook:"],
            },
            otherConfig: true,
          });
        }
        return "";
      });

      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--non-interactive",
      ]);

      const openclawWrite = mockWriteFileSync.mock.calls.find(
        ([path]) => path === openclawConfigPath,
      );
      expect(openclawWrite).toBeUndefined();
      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("openclawConfigPath: ~/.openclaw/openclaw.json");
      expect(writtenYaml).not.toContain("old-token");
    });

    it("preserves existing projects in config", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("my-app");
      expect(writtenYaml).toContain("owner/repo");
    });

    it("writes to the correct config path", async () => {
      mockFindConfigFile.mockReturnValue("/custom/path/agent-orchestrator.yaml");
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      expect(mockWriteFileSync.mock.calls[0][0]).toBe("/custom/path/agent-orchestrator.yaml");
    });
  });

  describe("error handling", () => {
    it("exits when no config file found", async () => {
      mockFindConfigFile.mockReturnValue(null);
      const program = createProgram();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "setup",
          "openclaw",
          "--url",
          "http://127.0.0.1:18789/hooks/agent",
          "--token",
          "tok",
          "--non-interactive",
        ]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("skips validation and writes config even with bad token in non-interactive mode", async () => {
      mockValidateToken.mockResolvedValue({ valid: false, error: "Token rejected" });
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "bad-token",
        "--non-interactive",
      ]);

      // nonInteractiveSetup skips pre-write validation, so config should still be written
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it("exits when --url missing and gateway unreachable in non-interactive mode", async () => {
      mockDetectOpenClawInstallation.mockResolvedValue({
        state: "missing",
        gatewayUrl: "http://127.0.0.1:18789",
        probe: { reachable: false, error: "ECONNREFUSED" },
      });
      const program = createProgram();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "setup",
          "openclaw",
          "--token",
          "tok",
          "--non-interactive",
        ]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("fails when no OpenClaw-owned token is available in non-interactive mode", async () => {
      delete process.env["OPENCLAW_HOOKS_TOKEN"];
      const program = createProgram();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "setup",
          "openclaw",
          "--url",
          "http://127.0.0.1:18789/hooks/agent",
          "--non-interactive",
        ]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("fails on conflicting openclaw notifier config in non-interactive mode", async () => {
      mockReadFileSync.mockReturnValue(`
port: 3000
defaults: {}
notifiers:
  openclaw:
    plugin: webhook
    url: https://example.com/hook
projects: {}
`);
      const program = createProgram();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "setup",
          "openclaw",
          "--url",
          "http://127.0.0.1:18789/hooks/agent",
          "--token",
          "tok",
          "--non-interactive",
        ]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });
});

describe("setup desktop command", () => {
  const originalEnv = { ...process.env };
  const sourceApp = "/tmp/source/AO Notifier.app";
  const targetApp = "/tmp/home/Applications/AO Notifier.app";

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    process.env["AO_DESKTOP_SETUP_PLATFORM"] = "darwin";
    process.env["AO_NOTIFIER_MACOS_APP_PATH"] = sourceApp;
    process.env["AO_DESKTOP_APP_INSTALL_PATH"] = targetApp;
    mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
    mockReadFileSync.mockReturnValue(MINIMAL_CONFIG);
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined);
    mockCpSync.mockImplementation(() => undefined);
    mockRmSync.mockImplementation(() => undefined);
    mockExistsSync.mockImplementation((path: string) =>
      normalizePathSeparators(path).endsWith("AO Notifier.app/Contents/MacOS/ao-notifier"),
    );
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--permission-status-json")) {
        return '{"status":"authorized","bundleId":"com.aoagents.notifier"}';
      }
      if (args.includes("--version-json")) {
        return '{"name":"AO Notifier","version":"0.6.0","bundleId":"com.aoagents.notifier"}';
      }
      if (args.includes("--request-permission")) {
        return '{"status":"authorized","bundleId":"com.aoagents.notifier"}';
      }
      return "";
    });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("registers the desktop setup command", () => {
    const program = createProgram();
    const setup = program.commands.find((command) => command.name() === "setup");
    expect(setup?.commands.some((command) => command.name() === "desktop")).toBe(true);
  });

  it("installs the bundled app and wires desktop routing to all priorities", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "desktop", "--non-interactive"]);

    expect(mockCpSync).toHaveBeenCalledWith(sourceApp, targetApp, { recursive: true });
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, { plugin?: string; backend?: string; dashboardUrl?: string }>;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["desktop"]).toMatchObject({
      plugin: "desktop",
      backend: "ao-app",
      dashboardUrl: "http://localhost:3000",
    });
    expect(parsed.notificationRouting?.["urgent"]).toContain("desktop");
    expect(parsed.notificationRouting?.["action"]).toContain("desktop");
    expect(parsed.notificationRouting?.["warning"]).toContain("desktop");
    expect(parsed.notificationRouting?.["info"]).toContain("desktop");
  });

  it("configures terminal-notifier backend without installing AO Notifier.app", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "desktop",
      "--backend",
      "terminal-notifier",
      "--non-interactive",
    ]);

    expect(mockCpSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith("terminal-notifier", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "terminal-notifier",
      [
        "-title",
        "AO Notifier",
        "-message",
        "Desktop notifications are ready.",
        "-open",
        "http://localhost:3000",
      ],
      expect.any(Object),
    );

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, { plugin?: string; backend?: string; dashboardUrl?: string }>;
    };
    expect(parsed.notifiers?.["desktop"]).toMatchObject({
      plugin: "desktop",
      backend: "terminal-notifier",
      dashboardUrl: "http://localhost:3000",
    });
  });

  it("configures osascript backend without installing AO Notifier.app", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "desktop",
      "--backend",
      "osascript",
      "--non-interactive",
    ]);

    expect(mockCpSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith("osascript", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "osascript",
      ["-e", 'display notification "Desktop notifications are ready." with title "AO Notifier"'],
      expect.any(Object),
    );

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, { plugin?: string; backend?: string }>;
    };
    expect(parsed.notifiers?.["desktop"]).toMatchObject({
      plugin: "desktop",
      backend: "osascript",
    });
  });

  it("refreshes existing backend and dashboard URL without reinstalling when app exists", async () => {
    mockReadFileSync.mockReturnValue(`
port: 4217
notifiers:
  desktop:
    plugin: desktop
    backend: terminal-notifier
    dashboardUrl: http://localhost:3000
    sound: false
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "desktop",
      "--refresh",
      "--no-test",
      "--non-interactive",
    ]);

    expect(mockCpSync).not.toHaveBeenCalled();
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<
        string,
        { plugin?: string; backend?: string; dashboardUrl?: string; sound?: boolean }
      >;
    };
    expect(parsed.notifiers?.["desktop"]).toMatchObject({
      plugin: "desktop",
      backend: "terminal-notifier",
      dashboardUrl: "http://localhost:4217",
      sound: false,
    });
  });

  it("uses explicit dashboard URL override", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "desktop",
      "--backend",
      "osascript",
      "--dashboard-url",
      "http://localhost:7777",
      "--no-test",
      "--non-interactive",
    ]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, { dashboardUrl?: string }>;
    };
    expect(parsed.notifiers?.["desktop"]?.dashboardUrl).toBe("http://localhost:7777");
  });

  it("installs and writes an explicit AO app path", async () => {
    const customAppPath = "/tmp/custom/AO Notifier.app";
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "desktop",
      "--app-path",
      customAppPath,
      "--force",
      "--non-interactive",
    ]);

    expect(mockCpSync).toHaveBeenCalledWith(sourceApp, customAppPath, { recursive: true });
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, { appPath?: string }>;
    };
    expect(parsed.notifiers?.["desktop"]?.appPath).toBe(customAppPath);
  });

  it("skips setup test notification with --no-test", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "desktop",
      "--no-test",
      "--non-interactive",
    ]);

    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining("ao-notifier"),
      ["--notify-base64", expect.any(String)],
      expect.any(Object),
    );
  });

  it("fails for missing terminal-notifier in non-interactive mode", async () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "terminal-notifier" && args[0] === "--version") {
        const error = new Error("not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return "";
    });
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "desktop",
        "--backend",
        "terminal-notifier",
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("preserves existing routing entries while adding desktop", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3001
defaults:
  notifiers:
    - slack
notifiers:
  slack:
    plugin: slack
notificationRouting:
  urgent:
    - slack
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "desktop", "--non-interactive"]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notificationRouting?: Record<string, string[]>;
      defaults?: { notifiers?: string[] };
    };
    expect(parsed.notificationRouting?.["urgent"]).toEqual(["slack", "desktop"]);
    expect(parsed.notificationRouting?.["action"]).toEqual(["slack", "desktop"]);
    expect(parsed.defaults?.notifiers).toEqual(["slack"]);
  });

  it("fails on conflicting desktop notifier config in non-interactive mode", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  desktop:
    plugin: webhook
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync(["node", "test", "setup", "desktop", "--non-interactive"]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("stops immediately when interactive conflict replacement is declined", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  desktop:
    plugin: webhook
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.confirm.mockResolvedValueOnce(false);
    mockClack.isCancel.mockReturnValue(false);
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "desktop"]);

    expect(mockCpSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("allows replacing conflicting desktop notifier config with --force", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  desktop:
    plugin: webhook
    url: http://example.com
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "desktop", "--force", "--non-interactive"]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, { plugin?: string; backend?: string }>;
    };
    expect(parsed.notifiers?.["desktop"]).toMatchObject({ plugin: "desktop", backend: "ao-app" });
  });

  it("reports denied notification permission without writing config", async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--request-permission")) {
        const error = new Error("Command failed") as Error & { stdout: Buffer; stderr: Buffer };
        error.stdout = Buffer.from('{"status":"denied","bundleId":"com.aoagents.notifier"}\n');
        error.stderr = Buffer.alloc(0);
        throw error;
      }
      return "";
    });
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      program.parseAsync(["node", "test", "setup", "desktop", "--non-interactive"]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("System Settings"));
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("refuses to install a non-macOS placeholder AO Notifier.app", async () => {
    mockExistsSync.mockImplementation(
      (path: string) =>
        normalizePathSeparators(path).endsWith("AO Notifier.app/Contents/MacOS/ao-notifier") ||
        normalizePathSeparators(path).endsWith(
          "AO Notifier.app/Contents/Resources/ao-notifier-placeholder",
        ),
    );
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      program.parseAsync(["node", "test", "setup", "desktop", "--non-interactive"]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("non-macOS placeholder and cannot be installed"),
    );
    expect(mockCpSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("shows status without installing or writing config", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "desktop", "--status"]);

    expect(mockCpSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith("terminal-notifier", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(mockExecFileSync).toHaveBeenCalledWith("osascript", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("uninstalls the app without changing config", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "desktop", "--uninstall"]);

    expect(mockRmSync).toHaveBeenCalledWith(targetApp, { recursive: true, force: true });
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("exits on non-macOS install attempts", async () => {
    process.env["AO_DESKTOP_SETUP_PLATFORM"] = "linux";
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync(["node", "test", "setup", "desktop", "--non-interactive"]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockCpSync).not.toHaveBeenCalled();
  });
});

describe("setup webhook command", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
    mockReadFileSync.mockReturnValue(MINIMAL_CONFIG);
    mockWriteFileSync.mockImplementation(() => {});
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    for (const fn of Object.values(mockClack)) fn.mockReset();
    mockClack.confirm.mockResolvedValue(true);
    mockClack.isCancel.mockReturnValue(false);
    mockClack.password.mockResolvedValue("");
    mockClack.select.mockResolvedValue("use-existing");
    mockClack.text.mockResolvedValue("");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("registers the webhook setup command", () => {
    const program = createProgram();
    const setup = program.commands.find((command) => command.name() === "setup");
    expect(setup?.commands.some((command) => command.name() === "webhook")).toBe(true);
  });

  it("interactive setup asks whether to use an existing webhook URL", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  webhook:
    plugin: webhook
    url: https://old.example.com/ao-events
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select.mockResolvedValue("use-existing");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "webhook"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Webhook notifier is already configured. What do you want to do?",
      }),
    );
    expect(mockClack.text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Webhook URL:" }),
    );
    expect(mockFetch).toHaveBeenCalledWith("https://old.example.com/ao-events", expect.any(Object));
  });

  it("interactive setup can add a new webhook URL", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  webhook:
    plugin: webhook
    url: https://old.example.com/ao-events
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select.mockResolvedValueOnce("add-new").mockResolvedValueOnce("enter-url");
    mockClack.text.mockResolvedValueOnce(NEW_EXAMPLE_WEBHOOK_URL);
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "webhook"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to configure the webhook URL?",
      }),
    );
    expect(mockFetch).toHaveBeenCalledWith("https://new.example.com/ao-events", expect.any(Object));
  });

  it("interactive setup can navigate back from adding a new webhook URL", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  webhook:
    plugin: webhook
    url: https://old.example.com/ao-events
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select
      .mockResolvedValueOnce("add-new")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("use-existing");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "webhook"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to configure the webhook URL?",
      }),
    );
    expect(mockClack.text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Webhook URL:" }),
    );
    expect(mockFetch).toHaveBeenCalledWith("https://old.example.com/ao-events", expect.any(Object));
  });

  it("interactive setup can be cancelled before writing webhook config", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  webhook:
    plugin: webhook
    url: https://old.example.com/ao-events
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select.mockResolvedValue("cancel");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = createProgram();

    await expect(program.parseAsync(["node", "test", "setup", "webhook"])).rejects.toThrow(
      "process.exit",
    );

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("tests the endpoint and writes url-only webhook config", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "webhook",
      "--url",
      EXAMPLE_WEBHOOK_URL,
      "--non-interactive",
    ]);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/ao-events",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<
        string,
        { plugin?: string; url?: string; headers?: Record<string, string> }
      >;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["webhook"]).toMatchObject({
      plugin: "webhook",
      url: "https://example.com/ao-events",
    });
    expect(parsed.notifiers?.["webhook"]?.headers).toBeUndefined();
    expect(parsed.notificationRouting?.["urgent"]).toContain("webhook");
    expect(parsed.notificationRouting?.["action"]).toContain("webhook");
    expect(parsed.notificationRouting?.["warning"]).toContain("webhook");
    expect(parsed.notificationRouting?.["info"]).toContain("webhook");
  });

  it("writes bearer auth into webhook headers when auth token is provided", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "webhook",
      "--url",
      EXAMPLE_WEBHOOK_URL,
      "--auth-token",
      "secret-token",
      "--non-interactive",
    ]);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/ao-events",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
      }),
    );
    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, { headers?: Record<string, string> }>;
    };

    expect(parsed.notifiers?.["webhook"]?.headers).toEqual({
      Authorization: "Bearer secret-token",
    });
  });

  it("does not write config when setup test fails", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: vi.fn().mockResolvedValue("bad token"),
    });
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "webhook",
        "--url",
        EXAMPLE_WEBHOOK_URL,
        "--auth-token",
        "bad-token",
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("writes config without probing when --no-test is used", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "webhook",
      "--url",
      EXAMPLE_WEBHOOK_URL,
      "--no-test",
      "--non-interactive",
    ]);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("refreshes existing webhook config and preserves bearer token", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  webhook:
    plugin: webhook
    url: https://old.example.com/ao-events
    headers:
      Authorization: Bearer existing-token
    retries: 5
    retryDelayMs: 2500
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "webhook",
      "--refresh",
      "--url",
      NEW_EXAMPLE_WEBHOOK_URL,
      "--non-interactive",
    ]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<
        string,
        { url?: string; headers?: Record<string, string>; retries?: number; retryDelayMs?: number }
      >;
    };

    expect(parsed.notifiers?.["webhook"]).toMatchObject({
      url: "https://new.example.com/ao-events",
      headers: { Authorization: "Bearer existing-token" },
      retries: 5,
      retryDelayMs: 2500,
    });
  });

  it("shows status without writing config", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  webhook:
    plugin: webhook
    url: https://example.com/ao-events
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "webhook", "--status"]);

    expect(mockFetch).toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("fails on conflicting webhook notifier config in non-interactive mode", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  webhook:
    plugin: slack
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "webhook",
        "--url",
        EXAMPLE_WEBHOOK_URL,
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("setup slack command", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
    mockReadFileSync.mockReturnValue(MINIMAL_CONFIG);
    mockWriteFileSync.mockImplementation(() => {});
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: vi.fn().mockResolvedValue("ok"),
    });
    vi.stubGlobal("fetch", mockFetch);
    for (const fn of Object.values(mockClack)) fn.mockReset();
    mockClack.confirm.mockResolvedValue(true);
    mockClack.isCancel.mockReturnValue(false);
    mockClack.select.mockResolvedValue("have-url");
    mockClack.text.mockResolvedValue("");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("registers the slack setup command", () => {
    const program = createProgram();
    const setup = program.commands.find((command) => command.name() === "setup");
    expect(setup?.commands.some((command) => command.name() === "slack")).toBe(true);
  });

  it("interactive setup asks whether to reuse an existing Slack webhook", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  slack:
    plugin: slack
    webhookUrl: https://hooks.slack.com/services/TOLD/BOLD/old
    channel: "#old-agents"
    username: Existing AO
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select.mockResolvedValue("use-existing");
    mockClack.text.mockResolvedValueOnce("#agents").mockResolvedValueOnce("AO");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "slack"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Slack notifier is already configured. What do you want to do?",
      }),
    );
    expect(mockClack.text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Slack incoming webhook URL:" }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/TOLD/BOLD/old",
      expect.any(Object),
    );
  });

  it("interactive setup prints creation steps and waits for a Slack webhook URL", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select.mockResolvedValueOnce("need-url").mockResolvedValueOnce("enter-url");
    mockClack.text
      .mockResolvedValueOnce(SLACK_SECRET_WEBHOOK_URL)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("AO");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "slack"]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Create a Slack incoming webhook"));
    expect(mockClack.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Slack incoming webhook URL:" }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/T000/B000/secret",
      expect.any(Object),
    );
  });

  it("interactive setup can navigate back from Slack webhook instructions", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  slack:
    plugin: slack
    webhookUrl: https://hooks.slack.com/services/TOLD/BOLD/old
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select
      .mockResolvedValueOnce("need-url")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("use-existing");
    mockClack.text.mockResolvedValueOnce("").mockResolvedValueOnce("AO");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "slack"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "After creating the Slack webhook, what do you want to do?",
      }),
    );
    expect(mockClack.text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Slack incoming webhook URL:" }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/TOLD/BOLD/old",
      expect.any(Object),
    );
  });

  it("interactive setup can navigate back from changing the Slack webhook URL", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  slack:
    plugin: slack
    webhookUrl: https://hooks.slack.com/services/TOLD/BOLD/old
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select
      .mockResolvedValueOnce("change-url")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("use-existing");
    mockClack.text.mockResolvedValueOnce("").mockResolvedValueOnce("AO");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "slack"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to change the Slack webhook URL?",
      }),
    );
    expect(mockClack.text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Slack incoming webhook URL:" }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/TOLD/BOLD/old",
      expect.any(Object),
    );
  });

  it("interactive setup can be cancelled before writing Slack config", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select.mockResolvedValue("cancel");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = createProgram();

    await expect(program.parseAsync(["node", "test", "setup", "slack"])).rejects.toThrow(
      "process.exit",
    );

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("tests the endpoint and writes url-only Slack config", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "slack",
      "--webhook-url",
      SLACK_SECRET_WEBHOOK_URL,
      "--non-interactive",
    ]);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/T000/B000/secret",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      username?: string;
      channel?: string;
      text?: string;
    };
    expect(payload).toMatchObject({
      username: "Agent Orchestrator",
      text: "AO Slack notifications are ready.",
    });
    expect(payload.channel).toBeUndefined();

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<
        string,
        { plugin?: string; webhookUrl?: string; username?: string; channel?: string }
      >;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["slack"]).toMatchObject({
      plugin: "slack",
      webhookUrl: "https://hooks.slack.com/services/T000/B000/secret",
      username: "Agent Orchestrator",
    });
    expect(parsed.notifiers?.["slack"]?.channel).toBeUndefined();
    expect(parsed.notificationRouting?.["urgent"]).toContain("slack");
    expect(parsed.notificationRouting?.["action"]).toContain("slack");
    expect(parsed.notificationRouting?.["warning"]).toContain("slack");
    expect(parsed.notificationRouting?.["info"]).toContain("slack");
  });

  it("writes optional channel and username when provided", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "slack",
      "--webhook-url",
      SLACK_SECRET_WEBHOOK_URL,
      "--channel",
      "#agents",
      "--username",
      "AO",
      "--non-interactive",
    ]);

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      username?: string;
      channel?: string;
    };
    expect(payload).toMatchObject({
      username: "AO",
      channel: "#agents",
    });

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, { username?: string; channel?: string }>;
    };
    expect(parsed.notifiers?.["slack"]).toMatchObject({
      username: "AO",
      channel: "#agents",
    });
  });

  it("does not write config when Slack setup test fails", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: vi.fn().mockResolvedValue("no_service"),
    });
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "slack",
        "--webhook-url",
        SLACK_BAD_WEBHOOK_URL,
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("writes config without probing when --no-test is used", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "slack",
      "--webhook-url",
      SLACK_SECRET_WEBHOOK_URL,
      "--no-test",
      "--non-interactive",
    ]);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("refreshes existing Slack config and preserves channel and username", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  slack:
    plugin: slack
    webhookUrl: https://hooks.slack.com/services/TOLD/BOLD/old
    channel: "#old-agents"
    username: AO
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "slack",
      "--refresh",
      "--webhook-url",
      SLACK_NEW_WEBHOOK_URL,
      "--non-interactive",
    ]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<string, { webhookUrl?: string; username?: string; channel?: string }>;
    };

    expect(parsed.notifiers?.["slack"]).toMatchObject({
      webhookUrl: "https://hooks.slack.com/services/TNEW/BNEW/new",
      channel: "#old-agents",
      username: "AO",
    });
  });

  it("shows status without writing config", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  slack:
    plugin: slack
    webhookUrl: https://hooks.slack.com/services/T000/B000/secret
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "slack", "--status"]);

    expect(mockFetch).toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("fails on conflicting Slack notifier config in non-interactive mode", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  slack:
    plugin: webhook
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "slack",
        "--webhook-url",
        SLACK_SECRET_WEBHOOK_URL,
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("setup discord command", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
    mockReadFileSync.mockReturnValue(MINIMAL_CONFIG);
    mockWriteFileSync.mockImplementation(() => {});
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      text: vi.fn().mockResolvedValue(""),
      headers: { get: vi.fn().mockReturnValue(null) },
    });
    vi.stubGlobal("fetch", mockFetch);
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("registers the discord setup command", () => {
    const program = createProgram();
    const setup = program.commands.find((command) => command.name() === "setup");
    expect(setup?.commands.some((command) => command.name() === "discord")).toBe(true);
  });

  it("interactive setup asks whether to reuse an existing Discord webhook", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  discord:
    plugin: discord
    webhookUrl: https://discord.com/api/webhooks/existing/secret
    username: Existing AO
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select.mockResolvedValue("use-existing");
    mockClack.text
      .mockResolvedValueOnce("AO")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("1000");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "discord"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Discord notifier is already configured. What do you want to do?",
      }),
    );
    expect(mockClack.text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Discord webhook URL:" }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/existing/secret",
      expect.any(Object),
    );
  });

  it("interactive setup prints creation steps and waits for a Discord webhook URL", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select.mockResolvedValueOnce("need-url").mockResolvedValueOnce("enter-url");
    mockClack.text
      .mockResolvedValueOnce("https://discord.com/api/webhooks/123/secret")
      .mockResolvedValueOnce("AO")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("1000");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "discord"]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Create a Discord incoming webhook"),
    );
    expect(mockClack.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Discord webhook URL:" }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/secret",
      expect.any(Object),
    );
  });

  it("interactive setup can navigate back from Discord webhook instructions", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  discord:
    plugin: discord
    webhookUrl: https://discord.com/api/webhooks/existing/secret
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select
      .mockResolvedValueOnce("need-url")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("use-existing");
    mockClack.text
      .mockResolvedValueOnce("AO")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("1000");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "discord"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "After creating the Discord webhook, what do you want to do?",
      }),
    );
    expect(mockClack.text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Discord webhook URL:" }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/existing/secret",
      expect.any(Object),
    );
  });

  it("interactive setup can navigate back from changing the Discord webhook URL", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  discord:
    plugin: discord
    webhookUrl: https://discord.com/api/webhooks/existing/secret
projects:
  my-app:
    name: my-app
`);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select
      .mockResolvedValueOnce("change-url")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("use-existing");
    mockClack.text
      .mockResolvedValueOnce("AO")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("1000");
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "discord"]);

    expect(mockClack.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to change the Discord webhook URL?",
      }),
    );
    expect(mockClack.text).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Discord webhook URL:" }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/existing/secret",
      expect.any(Object),
    );
  });

  it("interactive setup can be cancelled before writing Discord config", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockClack.select.mockResolvedValue("cancel");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const program = createProgram();

    await expect(program.parseAsync(["node", "test", "setup", "discord"])).rejects.toThrow(
      "process.exit",
    );

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("tests the endpoint and writes url-only Discord config", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "discord",
      "--webhook-url",
      "https://discord.com/api/webhooks/123/secret",
      "--non-interactive",
    ]);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/secret",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      username?: string;
      content?: string;
      avatar_url?: string;
    };
    expect(payload).toMatchObject({
      username: "Agent Orchestrator",
      content: "AO Discord notifications are ready.",
    });
    expect(payload.avatar_url).toBeUndefined();

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<
        string,
        {
          plugin?: string;
          webhookUrl?: string;
          username?: string;
          avatarUrl?: string;
          threadId?: string;
          retries?: number;
          retryDelayMs?: number;
        }
      >;
      notificationRouting?: Record<string, string[]>;
    };

    expect(parsed.notifiers?.["discord"]).toMatchObject({
      plugin: "discord",
      webhookUrl: "https://discord.com/api/webhooks/123/secret",
      username: "Agent Orchestrator",
      retries: 2,
      retryDelayMs: 1000,
    });
    expect(parsed.notifiers?.["discord"]?.avatarUrl).toBeUndefined();
    expect(parsed.notifiers?.["discord"]?.threadId).toBeUndefined();
    expect(parsed.notificationRouting?.["urgent"]).toContain("discord");
    expect(parsed.notificationRouting?.["action"]).toContain("discord");
    expect(parsed.notificationRouting?.["warning"]).toContain("discord");
    expect(parsed.notificationRouting?.["info"]).toContain("discord");
  });

  it("writes optional username avatar thread and retry config when provided", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "discord",
      "--webhook-url",
      "https://discord.com/api/webhooks/123/secret",
      "--username",
      "AO",
      "--avatar-url",
      "https://example.com/avatar.png",
      "--thread-id",
      "987654321",
      "--retries",
      "4",
      "--retry-delay-ms",
      "2500",
      "--non-interactive",
    ]);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/secret?thread_id=987654321",
      expect.any(Object),
    );
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      username?: string;
      avatar_url?: string;
    };
    expect(payload).toMatchObject({
      username: "AO",
      avatar_url: "https://example.com/avatar.png",
    });

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<
        string,
        {
          username?: string;
          avatarUrl?: string;
          threadId?: string;
          retries?: number;
          retryDelayMs?: number;
        }
      >;
    };
    expect(parsed.notifiers?.["discord"]).toMatchObject({
      username: "AO",
      avatarUrl: "https://example.com/avatar.png",
      threadId: "987654321",
      retries: 4,
      retryDelayMs: 2500,
    });
  });

  it("does not write config when Discord setup test fails", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: vi.fn().mockResolvedValue("Unknown Webhook"),
    });
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "discord",
        "--webhook-url",
        "https://discord.com/api/webhooks/123/bad",
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("writes config without probing when --no-test is used", async () => {
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "discord",
      "--webhook-url",
      "https://discord.com/api/webhooks/123/secret",
      "--no-test",
      "--non-interactive",
    ]);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("refreshes existing Discord config and preserves optional values", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  discord:
    plugin: discord
    webhookUrl: https://discord.com/api/webhooks/old/old
    username: AO
    avatarUrl: https://example.com/avatar.png
    threadId: "111"
    retries: 5
    retryDelayMs: 3000
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "setup",
      "discord",
      "--refresh",
      "--webhook-url",
      "https://discord.com/api/webhooks/new/new",
      "--non-interactive",
    ]);

    const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = parseYaml(writtenYaml) as {
      notifiers?: Record<
        string,
        {
          webhookUrl?: string;
          username?: string;
          avatarUrl?: string;
          threadId?: string;
          retries?: number;
          retryDelayMs?: number;
        }
      >;
    };

    expect(parsed.notifiers?.["discord"]).toMatchObject({
      webhookUrl: "https://discord.com/api/webhooks/new/new",
      username: "AO",
      avatarUrl: "https://example.com/avatar.png",
      threadId: "111",
      retries: 5,
      retryDelayMs: 3000,
    });
  });

  it("shows status without writing config", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  discord:
    plugin: discord
    webhookUrl: https://discord.com/api/webhooks/123/secret
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();

    await program.parseAsync(["node", "test", "setup", "discord", "--status"]);

    expect(mockFetch).toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("fails on conflicting Discord notifier config in non-interactive mode", async () => {
    mockReadFileSync.mockReturnValue(`
port: 3000
notifiers:
  discord:
    plugin: webhook
projects:
  my-app:
    name: my-app
`);
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "setup",
        "discord",
        "--webhook-url",
        "https://discord.com/api/webhooks/123/secret",
        "--non-interactive",
      ]),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});
