import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveLocalPluginEntrypoint, type InstalledPluginConfig, type PluginSlot } from "@aoagents/ao-core";

const registryData = createRequire(import.meta.url)("../assets/plugin-registry.json") as unknown[];

export interface MarketplacePluginEntry {
  id: string;
  package: string;
  slot: PluginSlot;
  description: string;
  source: "registry";
  setupAction?: "openclaw-setup";
  latestVersion?: string;
}

export const BUNDLED_MARKETPLACE_PLUGIN_CATALOG = registryData as MarketplacePluginEntry[];
export const DEFAULT_REMOTE_MARKETPLACE_REGISTRY_URL =
  "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/packages/cli/src/assets/plugin-registry.json";

const MARKETPLACE_CACHE_FILE = "plugin-registry.json";
const MARKETPLACE_FETCH_TIMEOUT_MS = 30_000;

function isPluginSlot(value: unknown): value is PluginSlot {
  return (
    value === "runtime" ||
    value === "agent" ||
    value === "workspace" ||
    value === "tracker" ||
    value === "scm" ||
    value === "notifier" ||
    value === "terminal"
  );
}

function isMarketplacePluginEntry(value: unknown): value is MarketplacePluginEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MarketplacePluginEntry>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.package === "string" &&
    isPluginSlot(candidate.slot) &&
    typeof candidate.description === "string" &&
    candidate.source === "registry"
  );
}

function mergeMarketplaceCatalogs(
  primary: MarketplacePluginEntry[],
  fallback: MarketplacePluginEntry[],
): MarketplacePluginEntry[] {
  const merged = new Map<string, MarketplacePluginEntry>();
  for (const entry of fallback) {
    merged.set(entry.id, entry);
  }
  for (const entry of primary) {
    merged.set(entry.id, entry);
  }
  return [...merged.values()];
}

export function getMarketplaceRegistryCachePath(): string {
  const override = process.env["AO_PLUGIN_REGISTRY_CACHE_PATH"];
  if (override && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), ".agent-orchestrator", MARKETPLACE_CACHE_FILE);
}

function validateMarketplaceCatalog(payload: unknown, sourceLabel: string): MarketplacePluginEntry[] {
  if (!Array.isArray(payload)) {
    throw new Error(`${sourceLabel} did not return a registry array.`);
  }

  const entries = payload.filter(isMarketplacePluginEntry);
  if (entries.length !== payload.length) {
    throw new Error(`${sourceLabel} returned invalid marketplace registry entries.`);
  }

  return entries;
}

function readMarketplaceCatalogFile(filePath: string): MarketplacePluginEntry[] | null {
  if (!existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return validateMarketplaceCatalog(parsed, filePath);
  } catch {
    return null;
  }
}

function writeMarketplaceCatalogCache(entries: MarketplacePluginEntry[]): void {
  const cachePath = getMarketplaceRegistryCachePath();
  mkdirSync(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
  renameSync(tempPath, cachePath);
}

export function loadMarketplaceCatalog(): MarketplacePluginEntry[] {
  const cached = readMarketplaceCatalogFile(getMarketplaceRegistryCachePath());
  if (!cached) {
    return [...BUNDLED_MARKETPLACE_PLUGIN_CATALOG];
  }
  return mergeMarketplaceCatalogs(cached, BUNDLED_MARKETPLACE_PLUGIN_CATALOG);
}

export async function refreshMarketplaceCatalog(
  url = process.env["AO_PLUGIN_REGISTRY_URL"] ?? DEFAULT_REMOTE_MARKETPLACE_REGISTRY_URL,
): Promise<MarketplacePluginEntry[]> {
  const response = await fetch(url, { signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Failed to fetch marketplace registry from ${url} (HTTP ${response.status}).`);
  }

  const parsed = (await response.json()) as unknown;
  const remoteEntries = validateMarketplaceCatalog(parsed, url);
  const mergedEntries = mergeMarketplaceCatalogs(remoteEntries, BUNDLED_MARKETPLACE_PLUGIN_CATALOG);
  writeMarketplaceCatalogCache(mergedEntries);
  return mergedEntries;
}

export { normalizeImportedPluginModule } from "@aoagents/ao-core";

export function isLocalPluginReference(reference: string): boolean {
  return (
    reference.startsWith("./") ||
    reference.startsWith("../") ||
    reference.startsWith("/") ||
    reference.startsWith("~/") ||
    isAbsolute(reference)
  );
}

export function findMarketplacePlugin(reference: string): MarketplacePluginEntry | undefined {
  return loadMarketplaceCatalog().find(
    (plugin) => plugin.id === reference || plugin.package === reference,
  );
}

function expandHomePath(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function parseNpmPackageReference(reference: string): { packageName: string; version?: string } {
  if (reference.startsWith("@")) {
    const slashIndex = reference.indexOf("/");
    const versionSeparator = slashIndex >= 0 ? reference.indexOf("@", slashIndex + 1) : -1;
    if (versionSeparator > 0) {
      return {
        packageName: reference.slice(0, versionSeparator),
        version: reference.slice(versionSeparator + 1),
      };
    }
    return { packageName: reference };
  }

  const versionSeparator = reference.lastIndexOf("@");
  if (versionSeparator > 0) {
    return {
      packageName: reference.slice(0, versionSeparator),
      version: reference.slice(versionSeparator + 1),
    };
  }

  return { packageName: reference };
}

export function buildPluginDescriptor(
  reference: string,
  configPath: string,
): {
  descriptor: InstalledPluginConfig;
  specifier: string;
  setupAction?: MarketplacePluginEntry["setupAction"];
} {
  const marketplacePlugin = findMarketplacePlugin(reference);
  if (marketplacePlugin) {
    return {
      descriptor: {
        name: marketplacePlugin.id,
        source: marketplacePlugin.source,
        package: marketplacePlugin.package,
        version: marketplacePlugin.latestVersion,
        enabled: true,
      },
      specifier: marketplacePlugin.package,
      setupAction: marketplacePlugin.setupAction,
    };
  }

  if (isLocalPluginReference(reference)) {
    const expandedReference = expandHomePath(reference);
    const absolutePath = isAbsolute(expandedReference)
      ? expandedReference
      : resolve(dirname(configPath), expandedReference);
    const entrypoint = resolveLocalPluginEntrypoint(absolutePath);
    if (!entrypoint) {
      throw new Error(`Could not resolve a plugin entrypoint from ${reference}`);
    }

    return {
      descriptor: {
        name: reference,
        source: "local",
        path: reference,
        enabled: true,
      },
      specifier: pathToFileURL(entrypoint).href,
    };
  }

  const { packageName, version } = parseNpmPackageReference(reference);

  return {
    descriptor: {
      name: reference,
      source: "npm",
      package: packageName,
      version,
      enabled: true,
    },
    specifier: packageName,
  };
}
