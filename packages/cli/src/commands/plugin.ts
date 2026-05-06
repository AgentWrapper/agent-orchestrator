import { readFileSync, renameSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import {
  withConfigSchema,
  createPluginRegistry,
  findConfigFile,
  isCanonicalGlobalConfigPath,
  loadConfig,
  type PluginSlot,
  type InstalledPluginConfig,
  type OrchestratorConfig,
} from "@aoagents/ao-core";
import { parseDocument } from "yaml";
import {
  buildPluginDescriptor,
  findMarketplacePlugin,
  loadMarketplaceCatalog,
  normalizeImportedPluginModule,
  refreshMarketplaceCatalog,
} from "../lib/plugin-marketplace.js";
import {
  getLatestPublishedPackageVersion,
  importPluginModuleFromSource,
  installPackageIntoStore,
  readInstalledPackageVersion,
  uninstallPackageFromStore,
} from "../lib/plugin-store.js";
import {
  buildDefaultPackageName,
  normalizePluginName,
  resolveScaffoldDirectory,
  scaffoldPlugin,
} from "../lib/plugin-scaffold.js";
import { runSetupAction } from "./setup.js";

function findInstalledPlugin(
  plugins: InstalledPluginConfig[],
  descriptor: InstalledPluginConfig,
): InstalledPluginConfig | undefined {
  return plugins.find((plugin) => {
    if (descriptor.package && plugin.package === descriptor.package) return true;
    if (descriptor.path && plugin.path === descriptor.path) return true;
    return plugin.name === descriptor.name;
  });
}

function upsertInstalledPlugin(
  plugins: InstalledPluginConfig[],
  descriptor: InstalledPluginConfig,
): InstalledPluginConfig[] {
  const existing = findInstalledPlugin(plugins, descriptor);
  if (!existing) {
    return [...plugins, descriptor];
  }

  return plugins.map((plugin) => (plugin === existing ? { ...existing, ...descriptor } : plugin));
}

function writePluginsConfig(configPath: string, plugins: InstalledPluginConfig[]): void {
  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawConfig = (doc.toJS() as Record<string, any>) ?? {};
  if (plugins.length === 0) {
    delete rawConfig.plugins;
  } else {
    rawConfig.plugins = plugins;
  }
  doc.contents = doc.createNode(
    isCanonicalGlobalConfigPath(configPath) ? rawConfig : withConfigSchema(rawConfig),
  ) as typeof doc.contents;
  const rendered = doc.toString({ indent: 2 });
  const tempPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tempPath, rendered, "utf-8");
  renameSync(tempPath, configPath);
}

function matchesPluginReference(plugin: InstalledPluginConfig, reference: string): boolean {
  const marketplacePlugin = findMarketplacePlugin(reference);
  return (
    plugin.name === reference ||
    plugin.package === reference ||
    plugin.path === reference ||
    (marketplacePlugin !== undefined &&
      (plugin.package === marketplacePlugin.package || plugin.name === marketplacePlugin.id))
  );
}

async function rollbackManagedPackageInstall(
  packageName: string,
  previousVersion: string | null,
): Promise<void> {
  if (previousVersion) {
    await installPackageIntoStore(packageName, previousVersion);
    return;
  }

  await uninstallPackageFromStore(packageName);
}

function formatInstallSummary(descriptor: InstalledPluginConfig, configPath: string): string {
  const version = descriptor.version ? ` @ ${descriptor.version}` : "";
  return `Installed ${descriptor.name}${version} (${descriptor.source}) into ${configPath}`;
}

async function installOrVerifyPlugin(
  config: OrchestratorConfig,
  descriptor: InstalledPluginConfig,
  specifier: string,
): Promise<InstalledPluginConfig> {
  if (!descriptor.package || descriptor.source === "local") {
    return verifyPluginDescriptor(config, descriptor, specifier);
  }

  const previousVersion = readInstalledPackageVersion(descriptor.package);
  let installCompleted = false;

  try {
    const installedVersion = await installPackageIntoStore(descriptor.package, descriptor.version);
    installCompleted = true;
    return await verifyPluginDescriptor(
      config,
      { ...descriptor, version: installedVersion },
      descriptor.package,
    );
  } catch (err) {
    if (installCompleted) {
      try {
        await rollbackManagedPackageInstall(descriptor.package, previousVersion);
      } catch (rollbackErr) {
        const message = err instanceof Error ? err.message : String(err);
        const rollbackMessage =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(
          `${message}\nRollback failed for ${descriptor.package}: ${rollbackMessage}`,
          { cause: rollbackErr },
        );
      }
    }
    throw err;
  }
}

async function resolveTargetVersion(plugin: InstalledPluginConfig): Promise<string> {
  if (!plugin.package) {
    throw new Error(
      `Plugin ${plugin.name} does not have a package-backed source and cannot be updated.`,
    );
  }

  const marketplacePlugin =
    findMarketplacePlugin(plugin.package) ?? findMarketplacePlugin(plugin.name);
  if (marketplacePlugin?.latestVersion) {
    return marketplacePlugin.latestVersion;
  }

  return getLatestPublishedPackageVersion(plugin.package);
}

async function updateManagedPlugin(
  configPath: string,
  config: OrchestratorConfig,
  plugin: InstalledPluginConfig,
): Promise<"updated" | "skipped"> {
  if (!plugin.package || plugin.source === "local") {
    throw new Error(
      `Plugin ${plugin.name} is local-only and cannot be updated through the AO store.`,
    );
  }

  const currentVersion = readInstalledPackageVersion(plugin.package) ?? plugin.version ?? null;
  const targetVersion = await resolveTargetVersion(plugin);

  if (currentVersion === targetVersion) {
    if (plugin.version !== currentVersion && currentVersion) {
      writePluginsConfig(
        configPath,
        upsertInstalledPlugin(config.plugins ?? [], { ...plugin, version: currentVersion }),
      );
    }
    console.log(chalk.dim(`${plugin.name} is already up to date (${targetVersion}).`));
    return "skipped";
  }

  const previousVersion = readInstalledPackageVersion(plugin.package);
  let installCompleted = false;

  try {
    const installedVersion = await installPackageIntoStore(plugin.package, targetVersion);
    installCompleted = true;
    const verifiedDescriptor = await verifyPluginDescriptor(
      config,
      { ...plugin, version: installedVersion },
      plugin.package,
    );
    writePluginsConfig(configPath, upsertInstalledPlugin(config.plugins ?? [], verifiedDescriptor));
    console.log(
      chalk.green(
        `Updated ${verifiedDescriptor.name} from ${currentVersion ?? "not installed"} to ${installedVersion}`,
      ),
    );
    return "updated";
  } catch (err) {
    if (installCompleted) {
      try {
        await rollbackManagedPackageInstall(plugin.package, previousVersion);
      } catch (rollbackErr) {
        const message = err instanceof Error ? err.message : String(err);
        const rollbackMessage =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(`${message}\nRollback failed for ${plugin.package}: ${rollbackMessage}`, {
          cause: rollbackErr,
        });
      }
    }
    throw err;
  }
}

async function verifyPluginDescriptor(
  config: OrchestratorConfig,
  descriptor: InstalledPluginConfig,
  specifier: string,
): Promise<InstalledPluginConfig> {
  const imported = normalizeImportedPluginModule(await importPluginModuleFromSource(specifier));
  if (!imported) {
    throw new Error(`Imported module ${specifier} does not export a valid AO plugin`);
  }

  const normalizedDescriptor: InstalledPluginConfig = {
    ...descriptor,
    name: imported.manifest.name,
  };

  const registry = createPluginRegistry();
  const tempConfig: OrchestratorConfig = {
    ...config,
    plugins: upsertInstalledPlugin(config.plugins ?? [], normalizedDescriptor),
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await registry.loadFromConfig(tempConfig, importPluginModuleFromSource);
  } finally {
    console.warn = originalWarn;
  }

  const registered = registry.get(imported.manifest.slot, imported.manifest.name);
  if (!registered) {
    throw new Error(
      `Plugin ${imported.manifest.name} imported successfully but did not load through the registry`,
    );
  }

  return normalizedDescriptor;
}

function printPluginListFromCatalog(
  config: OrchestratorConfig | null,
  installedOnly: boolean,
  catalog: ReturnType<typeof loadMarketplaceCatalog>,
  slotFilter?: string,
): void {
  const installed = config?.plugins ?? [];

  if (installedOnly) {
    const filtered = slotFilter
      ? installed.filter((p) => {
          const entry = catalog.find((e) => e.id === p.name || e.package === p.package);
          return entry?.slot === slotFilter;
        })
      : installed;

    if (filtered.length === 0) {
      console.log(
        chalk.dim(
          slotFilter
            ? `No installed plugins with type "${slotFilter}".`
            : "No plugins are installed in this config.",
        ),
      );
      return;
    }

    for (const plugin of filtered) {
      const source = plugin.source === "local" ? plugin.path : plugin.package;
      const version = plugin.version ? ` @ ${plugin.version}` : "";
      console.log(
        `${chalk.green(plugin.name)}${chalk.dim(version)} ${chalk.dim(`(${plugin.source}) ${source ?? ""}`)}`,
      );
    }
    return;
  }

  const filteredCatalog = slotFilter ? catalog.filter((p) => p.slot === slotFilter) : catalog;

  if (filteredCatalog.length === 0) {
    console.log(
      chalk.dim(
        slotFilter
          ? `No marketplace plugins with type "${slotFilter}".`
          : "No marketplace plugins found.",
      ),
    );
    return;
  }

  for (const plugin of filteredCatalog) {
    const isInstalled = installed.some(
      (entry) => entry.package === plugin.package || entry.name === plugin.id,
    );
    const marker = isInstalled ? chalk.green("installed") : chalk.dim("available");
    console.log(`${chalk.cyan(plugin.id)} ${chalk.dim(`(${plugin.slot})`)} ${marker}`);
    console.log(chalk.dim(`  ${plugin.description}`));
  }
}

export function registerPlugin(program: Command): void {
  const plugin = program.command("plugin").description("Browse and manage AO plugins");

  plugin
    .command("list")
    .description("List bundled marketplace plugins")
    .option("--installed", "Show only plugins installed in the current config")
    .option("--type <slot>", "Filter by plugin slot (e.g. agent, notifier, tracker)")
    .option("--refresh", "Fetch the latest registry and update the local marketplace cache")
    .action(async (opts: { installed?: boolean; type?: string; refresh?: boolean }) => {
      let config: OrchestratorConfig | null = null;
      const configPath = findConfigFile();
      if (configPath) {
        config = loadConfig(configPath);
      }
      const catalog =
        opts.refresh === true ? await refreshMarketplaceCatalog() : loadMarketplaceCatalog();
      printPluginListFromCatalog(config, opts.installed === true, catalog, opts.type);
    });

  plugin
    .command("search")
    .description("Search the bundled marketplace catalog")
    .argument("<query>", "Search term")
    .action((query: string) => {
      const normalizedQuery = query.trim().toLowerCase();
      const matches = loadMarketplaceCatalog().filter((plugin) => {
        return (
          plugin.id.toLowerCase().includes(normalizedQuery) ||
          plugin.package.toLowerCase().includes(normalizedQuery) ||
          plugin.description.toLowerCase().includes(normalizedQuery) ||
          plugin.slot.toLowerCase().includes(normalizedQuery)
        );
      });

      if (matches.length === 0) {
        console.log(chalk.dim(`No marketplace plugins matched "${query}".`));
        return;
      }

      for (const match of matches) {
        console.log(`${chalk.cyan(match.id)} ${chalk.dim(`(${match.slot})`)}`);
        console.log(chalk.dim(`  ${match.description}`));
      }
    });

  plugin
    .command("create")
    .description("Scaffold a new AO plugin package")
    .argument("[directory]", "Target directory for the new plugin")
    .option("--name <name>", "Display/plugin name")
    .option(
      "--slot <slot>",
      "Plugin slot: runtime | agent | workspace | tracker | scm | notifier | terminal",
    )
    .option("--description <description>", "Short plugin description")
    .option("--author <author>", "Package author")
    .option("--package-name <packageName>", "npm package name")
    .option("--non-interactive", "Skip prompts and require explicit values for required fields")
    .action(
      async (
        directory: string | undefined,
        opts: {
          name?: string;
          slot?: string;
          description?: string;
          author?: string;
          packageName?: string;
          nonInteractive?: boolean;
        },
      ) => {
        const slotOptions: PluginSlot[] = [
          "runtime",
          "agent",
          "workspace",
          "tracker",
          "scm",
          "notifier",
          "terminal",
        ];
        const isInteractive = process.stdin.isTTY && opts.nonInteractive !== true;
        let name = opts.name;
        let slot = slotOptions.find((candidate) => candidate === opts.slot);
        let description = opts.description;
        let author = opts.author ?? process.env["USER"] ?? process.env["USERNAME"];
        let packageName = opts.packageName;

        if (isInteractive) {
          const clack = await import("@clack/prompts");
          clack.intro(chalk.bgCyan(chalk.black(" ao plugin create ")));

          if (!name) {
            const value = await clack.text({
              message: "Plugin display name:",
              placeholder: "My Plugin",
              validate: (input) => {
                if (!input) return "Plugin name is required";
                try {
                  normalizePluginName(input);
                } catch (err) {
                  return err instanceof Error ? err.message : String(err);
                }
              },
            });
            if (clack.isCancel(value)) {
              clack.cancel("Plugin creation cancelled.");
              process.exit(0);
            }
            name = value as string;
          }

          if (!slot) {
            const value = await clack.select({
              message: "Plugin slot:",
              options: slotOptions.map((candidate) => ({ value: candidate, label: candidate })),
            });
            if (clack.isCancel(value)) {
              clack.cancel("Plugin creation cancelled.");
              process.exit(0);
            }
            slot = value as PluginSlot;
          }

          if (!description) {
            const value = await clack.text({
              message: "Short description:",
              placeholder: `AO ${slot} plugin`,
              validate: (input) => (!input ? "Description is required" : undefined),
            });
            if (clack.isCancel(value)) {
              clack.cancel("Plugin creation cancelled.");
              process.exit(0);
            }
            description = value as string;
          }

          if (!author) {
            const value = await clack.text({
              message: "Author:",
              placeholder: "Your Name",
            });
            if (clack.isCancel(value)) {
              clack.cancel("Plugin creation cancelled.");
              process.exit(0);
            }
            author = (value as string) || undefined;
          }

          if (!packageName) {
            const value = await clack.text({
              message: "Package name:",
              initialValue: buildDefaultPackageName(slot, name),
              validate: (input) => (!input ? "Package name is required" : undefined),
            });
            if (clack.isCancel(value)) {
              clack.cancel("Plugin creation cancelled.");
              process.exit(0);
            }
            packageName = value as string;
          }
        }

        if (!name) throw new Error("--name is required");
        if (!slot) throw new Error("--slot is required");
        if (!description) throw new Error("--description is required");

        const targetDirectory = resolveScaffoldDirectory(name, directory);
        const createdDir = scaffoldPlugin({
          author,
          description,
          directory: targetDirectory,
          displayName: name,
          packageName: packageName ?? buildDefaultPackageName(slot, name),
          slot,
        });

        console.log(chalk.green(`Created plugin scaffold at ${createdDir}`));
        console.log(chalk.dim(`  Package: ${packageName ?? buildDefaultPackageName(slot, name)}`));
        console.log(chalk.dim(`  Slot: ${slot}`));
        console.log(chalk.dim("  Next: npm install && npm run build"));
      },
    );

  plugin
    .command("install")
    .description("Install a plugin into the current config")
    .argument("<reference>", "Marketplace id, package name, or local path")
    .option(
      "--url <url>",
      "OpenClaw webhook URL (passed to setup when installing notifier-openclaw)",
    )
    .option(
      "--token <token>",
      "OpenClaw hooks auth token (passed to setup when installing notifier-openclaw)",
    )
    .action(async (reference: string, opts: { url?: string; token?: string }) => {
      const configPath = findConfigFile();
      if (!configPath) {
        throw new Error("No agent-orchestrator.yaml found. Run 'ao start' first.");
      }

      const config = loadConfig(configPath);
      const { descriptor, specifier, setupAction } = buildPluginDescriptor(reference, configPath);
      const verifiedDescriptor = await installOrVerifyPlugin(config, descriptor, specifier);
      const previousPlugins = config.plugins ?? [];
      const nextPlugins = upsertInstalledPlugin(previousPlugins, verifiedDescriptor);
      writePluginsConfig(configPath, nextPlugins);

      console.log(chalk.green(formatInstallSummary(verifiedDescriptor, configPath)));

      if (setupAction === "openclaw-setup") {
        // Always run setup — interactive in TTY, auto-detect in non-TTY.
        // Non-interactive setup will auto-detect OpenClaw on localhost if
        // no --url is given and the gateway is reachable.
        try {
          await runSetupAction({ url: opts.url, token: opts.token });
        } catch (err) {
          // Rollback: restore previous plugin list so a failed setup
          // doesn't leave a half-configured notifier enabled in config.
          writePluginsConfig(configPath, previousPlugins);
          console.log(chalk.dim("Rolled back plugin config after setup failure."));
          throw err;
        }
      }
    });

  plugin
    .command("update")
    .description("Update installer-managed plugins in the current config")
    .argument("[reference]", "Installed plugin name, marketplace id, or package name")
    .option("--all", "Update all installer-managed plugins in the current config")
    .action(async (reference: string | undefined, opts: { all?: boolean }) => {
      const configPath = findConfigFile();
      if (!configPath) {
        throw new Error("No agent-orchestrator.yaml found. Run 'ao start' first.");
      }

      if (!reference && opts.all !== true) {
        throw new Error("Specify a plugin reference or pass --all.");
      }

      let config = loadConfig(configPath);
      const managedPlugins = (config.plugins ?? []).filter((plugin) => plugin.source !== "local");
      const targets = opts.all
        ? managedPlugins
        : managedPlugins.filter((plugin) => reference && matchesPluginReference(plugin, reference));

      if (targets.length === 0) {
        throw new Error(
          opts.all
            ? "No installer-managed plugins are configured in this project."
            : `Plugin ${reference} is not installed in this config`,
        );
      }

      const failures: string[] = [];
      let updated = 0;
      let skipped = 0;

      for (const target of targets) {
        try {
          const result = await updateManagedPlugin(configPath, config, target);
          if (result === "updated") {
            updated++;
          } else {
            skipped++;
          }
          config = loadConfig(configPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${target.name}: ${message}`);
        }
      }

      if (updated > 0 || skipped > 0) {
        console.log(
          chalk.dim(
            `Plugin update summary: ${updated} updated, ${skipped} already current, ${failures.length} failed.`,
          ),
        );
      }

      if (failures.length > 0) {
        throw new Error(`Failed to update plugin(s):\n  ${failures.join("\n  ")}`);
      }
    });

  plugin
    .command("uninstall")
    .description("Remove a plugin from the current config")
    .argument("<reference>", "Installed plugin name, package name, or local path")
    .action((reference: string) => {
      const configPath = findConfigFile();
      if (!configPath) {
        throw new Error("No agent-orchestrator.yaml found. Run 'ao start' first.");
      }

      const config = loadConfig(configPath);
      const nextPlugins = (config.plugins ?? []).filter((plugin) => {
        return !matchesPluginReference(plugin, reference);
      });

      if (nextPlugins.length === (config.plugins ?? []).length) {
        throw new Error(`Plugin ${reference} is not installed in this config`);
      }

      writePluginsConfig(configPath, nextPlugins);
      console.log(chalk.green(`Removed ${reference} from ${configPath}`));
    });
}
