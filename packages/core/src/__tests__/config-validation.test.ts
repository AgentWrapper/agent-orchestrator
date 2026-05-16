/**
 * Unit tests for config validation (project uniqueness, prefix collisions, external plugins).
 */

import { describe, it, expect } from "vitest";
import { validateConfig } from "../config.js";

describe("Config Validation - Project Uniqueness", () => {
  it("accepts projects that share a basename when projectIds differ", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          sessionPrefix: "proj1",
          storageKey: "storage-proj1",
        },
        proj2: {
          path: "/other/integrator", // Same basename!
          repo: "org/integrator",
          defaultBranch: "main",
          sessionPrefix: "proj2",
          storageKey: "storage-proj2",
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it("accepts unique basenames", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });
});

describe("Config Validation - Numeric Fields", () => {
  const baseConfig = {
    projects: {
      app: {
        path: "/repos/app",
      },
    },
  };

  it("rejects fractional ports", () => {
    expect(() => validateConfig({ ...baseConfig, port: 3000.5 })).toThrow();
    expect(() => validateConfig({ ...baseConfig, terminalPort: 14800.5 })).toThrow();
    expect(() => validateConfig({ ...baseConfig, directTerminalPort: 14801.5 })).toThrow();
  });

  it("rejects fractional lifecycle grace periods", () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        lifecycle: { mergeCleanupIdleGraceMs: 300_000.5 },
      }),
    ).toThrow();
  });
});

describe("Config Validation - Session Prefix Uniqueness", () => {
  it("rejects duplicate explicit prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          sessionPrefix: "app",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          sessionPrefix: "app", // Same prefix!
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/Duplicate session prefix/);
    expect(() => validateConfig(config)).toThrow(/"app"/);
  });

  it("rejects duplicate auto-generated prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          // Auto-generates: "int"
        },
        proj2: {
          path: "/repos/international",
          repo: "org/international",
          defaultBranch: "main",
          // Auto-generates: "int" (collision!)
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/Duplicate session prefix/);
    expect(() => validateConfig(config)).toThrow(/"int"/);
  });

  it("error shows both conflicting projects", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
        },
        proj2: {
          path: "/repos/international",
          repo: "org/international",
          defaultBranch: "main",
        },
      },
    };

    try {
      validateConfig(config);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("integrator");
      expect(message).toContain("international");
    }
  });

  it("error suggests explicit sessionPrefix override", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          sessionPrefix: "app",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
    };

    try {
      validateConfig(config);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("sessionPrefix");
    }
  });

  it("accepts unique prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          sessionPrefix: "int",
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          sessionPrefix: "be",
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it("validates mix of explicit and auto-generated prefixes", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          sessionPrefix: "int", // Explicit
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          // Auto-generates: "bac"
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it("detects collision when explicit matches auto-generated", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
          // Auto-generates: "int"
        },
        proj2: {
          path: "/repos/backend",
          repo: "org/backend",
          defaultBranch: "main",
          sessionPrefix: "int", // Explicit collision with auto-generated
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/Duplicate session prefix/);
  });
});

describe("Config Validation - Session Prefix Regex", () => {
  it("accepts valid session prefixes", () => {
    const validPrefixes = ["int", "app", "my-app", "app_v2", "app123"];

    for (const prefix of validPrefixes) {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            sessionPrefix: prefix,
          },
        },
      };

      expect(() => validateConfig(config)).not.toThrow();
    }
  });

  it("rejects invalid session prefixes", () => {
    const invalidPrefixes = ["app!", "app@test", "app space", "app/test"];

    for (const prefix of invalidPrefixes) {
      const config = {
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            sessionPrefix: prefix,
          },
        },
      };

      expect(() => validateConfig(config)).toThrow();
    }
  });
});

describe("Config Validation - SCM webhook contract", () => {
  it("accepts a project scm webhook block and defaults enabled=true", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            plugin: "github",
            webhook: {
              path: "/api/webhooks/github",
              secretEnvVar: "GITHUB_WEBHOOK_SECRET",
              eventHeader: "x-github-event",
              deliveryHeader: "x-github-delivery",
              signatureHeader: "x-hub-signature-256",
              maxBodyBytes: 1048576,
            },
          },
        },
      },
    });

    expect(config.projects["proj1"]?.scm).toEqual({
      plugin: "github",
      webhook: {
        enabled: true,
        path: "/api/webhooks/github",
        secretEnvVar: "GITHUB_WEBHOOK_SECRET",
        eventHeader: "x-github-event",
        deliveryHeader: "x-github-delivery",
        signatureHeader: "x-hub-signature-256",
        maxBodyBytes: 1048576,
      },
    });
  });

  it("rejects non-positive scm webhook maxBodyBytes", () => {
    expect(() =>
      validateConfig({
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
            scm: {
              plugin: "github",
              webhook: {
                maxBodyBytes: 0,
              },
            },
          },
        },
      }),
    ).toThrow();
  });
});

describe("Config Schema Validation", () => {
  it("requires projects field", () => {
    const config = {
      // No projects
    };

    expect(() => validateConfig(config)).toThrow();
  });

  it("requires path, repo, and defaultBranch for each project", () => {
    const missingPath = {
      projects: {
        proj1: {
          repo: "org/test",
          defaultBranch: "main",
          // Missing path
        },
      },
    };

    const missingRepo = {
      projects: {
        proj1: {
          path: "/repos/test",
          defaultBranch: "main",
          // Missing repo
        },
      },
    };

    const missingBranch = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          // Missing defaultBranch (should use default)
        },
      },
    };

    expect(() => validateConfig(missingPath)).toThrow();
    // repo is optional — projects without a detected remote should still load
    expect(() => validateConfig(missingRepo)).not.toThrow();
    // missingBranch should work (defaults to "main")
    expect(() => validateConfig(missingBranch)).not.toThrow();
  });

  it("does not infer SCM or tracker when repo is missing", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          defaultBranch: "main",
          // No repo — SCM and tracker should not be inferred
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.repo).toBeUndefined();
    expect(validated.projects.proj1.scm).toBeUndefined();
    expect(validated.projects.proj1.tracker).toBeUndefined();
  });

  it("infers SCM and tracker when repo has owner/repo format", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ plugin: "github" });
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "github" });
  });

  it("does not infer SCM or tracker when repo has no slash", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "notaslash",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toBeUndefined();
    expect(validated.projects.proj1.tracker).toBeUndefined();
  });

  it("sessionPrefix is optional", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          // No sessionPrefix - will be auto-generated
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.sessionPrefix).toBeDefined();
    expect(validated.projects.proj1.sessionPrefix).toBe("test"); // "test" is 4 chars, used as-is
  });

  it("accepts a string-to-string env map at the project level", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          env: {
            GH_TOKEN: "ghp_xxx",
            CUSTOM_FLAG: "1",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.env).toEqual({
      GH_TOKEN: "ghp_xxx",
      CUSTOM_FLAG: "1",
    });
  });

  it("rejects non-string values in project env map", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          env: {
            GH_TOKEN: 123,
          },
        },
      },
    };

    expect(() => validateConfig(config)).toThrow();
  });

  it("accepts orchestratorModel in agentConfig", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          agentConfig: {
            model: "worker-model",
            orchestratorModel: "orchestrator-model",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.agentConfig?.model).toBe("worker-model");
    expect(validated.projects.proj1.agentConfig?.orchestratorModel).toBe("orchestrator-model");
  });

  it("accepts role-specific agent overrides at defaults and project scope", () => {
    const config = {
      defaults: {
        agent: "claude-code",
        orchestrator: {
          agent: "opencode",
        },
        worker: {
          agent: "codex",
        },
      },
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          orchestrator: {
            agent: "claude-code",
            agentConfig: {
              model: "orchestrator-model",
            },
          },
          worker: {
            agent: "codex",
            agentConfig: {
              model: "worker-model",
            },
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.defaults.orchestrator?.agent).toBe("opencode");
    expect(validated.defaults.worker?.agent).toBe("codex");
    expect(validated.projects.proj1.orchestrator?.agent).toBe("claude-code");
    expect(validated.projects.proj1.orchestrator?.agentConfig?.model).toBe("orchestrator-model");
    expect(validated.projects.proj1.worker?.agent).toBe("codex");
    expect(validated.projects.proj1.worker?.agentConfig?.model).toBe("worker-model");
  });

  it("does not inject default permissions into role-specific agent config", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          agentConfig: {
            permissions: "suggest",
          },
          worker: {
            agent: "codex",
            agentConfig: {
              model: "worker-model",
            },
          },
        },
      },
    });

    expect(config.projects.proj1.agentConfig?.permissions).toBe("suggest");
    expect(config.projects.proj1.worker?.agentConfig?.permissions).toBeUndefined();
  });
});

describe("Config Defaults", () => {
  it("applies default session prefix from project ID", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/integrator",
          repo: "org/integrator",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.sessionPrefix).toBe("int");
  });

  it("applies default project name from config key", () => {
    const config = {
      projects: {
        "my-project": {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects["my-project"].name).toBe("my-project");
  });

  it("applies default SCM from repo", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test", // Contains "/" → GitHub
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ plugin: "github" });
  });

  it("applies default tracker (GitHub issues)", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "github" });
  });

  it("infers GitLab tracker default from scm plugin", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            plugin: "gitlab",
            host: "gitlab.company.com",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm).toEqual({ plugin: "gitlab", host: "gitlab.company.com" });
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "gitlab" });
  });

  it("infers GitLab scm default from tracker plugin", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            plugin: "gitlab",
            host: "gitlab.com",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.tracker).toEqual({ plugin: "gitlab", host: "gitlab.com" });
    expect(validated.projects.proj1.scm).toEqual({ plugin: "gitlab" });
  });
});

describe("Config Validation - External Plugin Schema", () => {
  it("accepts tracker with plugin only (built-in)", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            plugin: "github",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.tracker?.plugin).toBe("github");
  });

  it("accepts tracker with package only (external npm)", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            package: "@acme/ao-plugin-tracker-jira",
            teamId: "TEAM-123",
          },
        },
      },
    };

    const validated = validateConfig(config);
    // Plugin name should be auto-generated from package
    expect(validated.projects.proj1.tracker?.plugin).toBe("jira");
    expect(validated.projects.proj1.tracker?.package).toBe("@acme/ao-plugin-tracker-jira");
  });

  it("accepts tracker with path only (local plugin)", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            path: "./plugins/my-tracker",
          },
        },
      },
    };

    const validated = validateConfig(config);
    // Plugin name should be auto-generated from path
    expect(validated.projects.proj1.tracker?.plugin).toBe("my-tracker");
    expect(validated.projects.proj1.tracker?.path).toBe("./plugins/my-tracker");
  });

  it("accepts tracker with both plugin and package (explicit naming)", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            plugin: "jira",
            package: "@acme/ao-plugin-tracker-jira",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.tracker?.plugin).toBe("jira");
    expect(validated.projects.proj1.tracker?.package).toBe("@acme/ao-plugin-tracker-jira");
  });

  it("rejects tracker with neither plugin nor package/path", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            teamId: "TEAM-123",
          },
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/plugin.*package.*path/i);
  });

  it("rejects tracker with both package and path", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            package: "@acme/ao-plugin-tracker-jira",
            path: "./plugins/my-tracker",
          },
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(/cannot have both/i);
  });

  it("accepts scm with package only", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            package: "@acme/ao-plugin-scm-bitbucket",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.scm?.plugin).toBe("bitbucket");
  });

  it("accepts notifier with package only", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
      notifiers: {
        teams: {
          package: "@acme/ao-plugin-notifier-teams",
          webhookUrl: "https://teams.webhook.url",
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.notifiers["teams"]?.plugin).toBe("teams");
    expect(validated.notifiers["teams"]?.package).toBe("@acme/ao-plugin-notifier-teams");
  });

  it("preserves plugin-specific config alongside package", () => {
    const config = {
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            package: "@acme/ao-plugin-tracker-jira",
            host: "https://jira.company.com",
            teamId: "TEAM-123",
          },
        },
      },
    };

    const validated = validateConfig(config);
    expect(validated.projects.proj1.tracker?.host).toBe("https://jira.company.com");
    expect(validated.projects.proj1.tracker?.teamId).toBe("TEAM-123");
  });
});

describe("collectExternalPluginConfigs", () => {
  // Note: validateConfig() internally calls collectExternalPluginConfigs() and stores
  // the results in config._externalPluginEntries. We test this by checking the stored entries.

  it("collects tracker with explicit plugin (validates manifest.name)", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            plugin: "jira",
            package: "@acme/ao-plugin-tracker-jira",
          },
        },
      },
    });

    // Check entries stored by validateConfig
    const entries = config._externalPluginEntries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "projects.proj1.tracker",
      location: { kind: "project", projectId: "proj1", configType: "tracker" },
      slot: "tracker",
      package: "@acme/ao-plugin-tracker-jira",
      expectedPluginName: "jira", // User explicitly specified plugin - will be validated
    });
  });

  it("collects scm with path (no explicit plugin - infers from manifest)", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            path: "./plugins/my-scm",
          },
        },
      },
    });

    // Check entries stored by validateConfig
    const entries = config._externalPluginEntries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "projects.proj1.scm",
      location: { kind: "project", projectId: "proj1", configType: "scm" },
      slot: "scm",
      path: "./plugins/my-scm",
    });
    // expectedPluginName should be undefined when plugin is not explicitly specified
    // This allows any manifest.name to be accepted
    expect(entries[0].expectedPluginName).toBeUndefined();
  });

  it("collects notifier with package (no explicit plugin - infers from manifest)", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
      notifiers: {
        teams: {
          package: "@acme/ao-plugin-notifier-teams",
        },
      },
    });

    // Check entries stored by validateConfig
    const entries = config._externalPluginEntries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "notifiers.teams",
      location: { kind: "notifier", notifierId: "teams" },
      slot: "notifier",
      package: "@acme/ao-plugin-notifier-teams",
    });
    // expectedPluginName should be undefined when plugin is not explicitly specified
    expect(entries[0].expectedPluginName).toBeUndefined();
  });

  it("collects multiple external plugins", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            package: "@acme/ao-plugin-tracker-jira",
          },
          scm: {
            path: "./plugins/my-scm",
          },
        },
      },
      notifiers: {
        teams: {
          package: "@acme/ao-plugin-notifier-teams",
        },
      },
    });

    // Check entries stored by validateConfig
    const entries = config._externalPluginEntries ?? [];
    expect(entries).toHaveLength(3);
  });

  it("ignores built-in plugins (plugin only)", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            plugin: "github",
          },
          scm: {
            plugin: "github",
          },
        },
      },
    });

    // No external plugins when only plugin name is specified (no package/path)
    const entries = config._externalPluginEntries ?? [];
    expect(entries).toHaveLength(0);
  });

  it("auto-generates plugins array entries from external plugin configs", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            package: "@acme/ao-plugin-tracker-jira",
          },
        },
      },
    });

    // plugins array should be auto-populated
    expect(config.plugins).toBeDefined();
    expect(config.plugins).toContainEqual(
      expect.objectContaining({
        source: "npm",
        package: "@acme/ao-plugin-tracker-jira",
        enabled: true,
      }),
    );
  });

  it("stores external plugin entries on config for validation", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            plugin: "jira",
            package: "@acme/ao-plugin-tracker-jira",
          },
        },
      },
    });

    expect(config._externalPluginEntries).toBeDefined();
    expect(config._externalPluginEntries).toHaveLength(1);
    expect(config._externalPluginEntries?.[0]).toMatchObject({
      source: "projects.proj1.tracker",
      expectedPluginName: "jira",
    });
  });
});

describe("External Plugin Name Generation", () => {
  it("extracts plugin name from scoped npm package", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            package: "@acme/ao-plugin-tracker-jira",
          },
        },
      },
    });

    expect(config.projects.proj1.tracker?.plugin).toBe("jira");
  });

  it("extracts plugin name from unscoped npm package", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            package: "ao-plugin-tracker-jira",
          },
        },
      },
    });

    expect(config.projects.proj1.tracker?.plugin).toBe("jira");
  });

  it("extracts plugin name from local path", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            path: "./plugins/my-custom-tracker",
          },
        },
      },
    });

    expect(config.projects.proj1.tracker?.plugin).toBe("my-custom-tracker");
  });

  it("extracts plugin name from absolute path", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            path: "/home/user/plugins/custom-tracker",
          },
        },
      },
    });

    expect(config.projects.proj1.tracker?.plugin).toBe("custom-tracker");
  });

  it("does not override explicit plugin name", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            plugin: "my-custom-name",
            package: "@acme/ao-plugin-tracker-jira",
          },
        },
      },
    });

    expect(config.projects.proj1.tracker?.plugin).toBe("my-custom-name");
  });

  it("handles local path without slashes correctly", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            path: "my-tracker",
          },
        },
      },
    });

    // Should use the path as-is (not split by hyphens like npm packages)
    expect(config.projects.proj1.tracker?.plugin).toBe("my-tracker");
  });

  it("preserves multi-word plugin names from scoped npm packages", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          tracker: {
            package: "@acme/ao-plugin-tracker-jira-cloud",
          },
        },
      },
    });

    // Should extract "jira-cloud" not just "cloud"
    expect(config.projects.proj1.tracker?.plugin).toBe("jira-cloud");
  });

  it("preserves multi-word plugin names from unscoped npm packages", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
          scm: {
            package: "ao-plugin-scm-azure-devops",
          },
        },
      },
    });

    // Should extract "azure-devops" not just "devops"
    expect(config.projects.proj1.scm?.plugin).toBe("azure-devops");
  });
});

describe("Config Validation - Power Config", () => {
  it("applies default power config with preventIdleSleep based on platform", () => {
    const config = validateConfig({
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    });

    // Default is true on darwin, false elsewhere
    expect(config.power).toBeDefined();
    expect(config.power!.preventIdleSleep).toBe(process.platform === "darwin");
  });

  it("accepts explicit power.preventIdleSleep: true", () => {
    const config = validateConfig({
      power: {
        preventIdleSleep: true,
      },
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    });

    expect(config.power!.preventIdleSleep).toBe(true);
  });

  it("accepts explicit power.preventIdleSleep: false", () => {
    const config = validateConfig({
      power: {
        preventIdleSleep: false,
      },
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          defaultBranch: "main",
        },
      },
    });

    expect(config.power!.preventIdleSleep).toBe(false);
  });

  it("rejects invalid power.preventIdleSleep type", () => {
    expect(() =>
      validateConfig({
        power: {
          preventIdleSleep: "yes", // Invalid: should be boolean
        },
        projects: {
          proj1: {
            path: "/repos/test",
            repo: "org/test",
            defaultBranch: "main",
          },
        },
      }),
    ).toThrow();
  });
});
