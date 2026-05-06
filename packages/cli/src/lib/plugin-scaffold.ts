import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PluginSlot } from "@aoagents/ao-core";

export interface PluginScaffoldInput {
  author?: string;
  description: string;
  directory: string;
  displayName: string;
  packageName: string;
  slot: PluginSlot;
}

const CORE_VERSION_RANGE = "^0.2.0";
const TYPESCRIPT_VERSION = "^5.7.0";
const NODE_TYPES_VERSION = "^25.2.3";

const SLOT_HINTS: Record<PluginSlot, string> = {
  runtime: "Implement a Runtime-compatible object from create() and wire up create/destroy/send lifecycle methods.",
  agent: "Implement an Agent-compatible object from create() so AO can launch, inspect, and restore sessions.",
  workspace: "Implement a Workspace-compatible object from create() for setup, cleanup, and isolation behavior.",
  tracker: "Implement a Tracker-compatible object from create() for issue list/read/update operations.",
  scm: "Implement an SCM-compatible object from create() for branch, PR, CI, and review operations.",
  notifier: "Implement a Notifier-compatible object from create() for notify() delivery logic.",
  terminal: "Implement a Terminal-compatible object from create() for attach/open UX.",
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizePluginName(value: string): string {
  const normalized = slugify(value);
  if (!normalized) {
    throw new Error("Plugin name must contain at least one letter or number.");
  }
  return normalized;
}

export function buildDefaultPackageName(slot: PluginSlot, pluginName: string): string {
  return `ao-plugin-${slot}-${normalizePluginName(pluginName)}`;
}

export function resolveScaffoldDirectory(displayName: string, targetDir?: string): string {
  return resolve(targetDir && targetDir.trim().length > 0 ? targetDir : normalizePluginName(displayName));
}

function ensureDirectoryIsWritable(targetDir: string): void {
  if (!existsSync(targetDir)) return;
  if (readdirSync(targetDir).length === 0) return;
  throw new Error(`Target directory ${targetDir} already exists and is not empty.`);
}

function buildPackageJson(input: PluginScaffoldInput): string {
  const manifestName = normalizePluginName(input.displayName);
  return `${JSON.stringify(
    {
      name: input.packageName,
      version: "0.1.0",
      description: input.description,
      license: "MIT",
      author: input.author,
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
      files: ["dist"],
      scripts: {
        build: "tsc",
        typecheck: "tsc --noEmit",
        clean: "rm -rf dist",
      },
      dependencies: {
        "@aoagents/ao-core": CORE_VERSION_RANGE,
      },
      devDependencies: {
        "@types/node": NODE_TYPES_VERSION,
        typescript: TYPESCRIPT_VERSION,
      },
      keywords: ["agent-orchestrator", "plugin", input.slot, manifestName],
    },
    null,
    2,
  )}\n`;
}

function buildTsConfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "Node16",
        moduleResolution: "Node16",
        lib: ["ES2022"],
        declaration: true,
        sourceMap: true,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`;
}

function buildIndexTs(input: PluginScaffoldInput): string {
  const manifestName = normalizePluginName(input.displayName);
  const displayName = input.displayName.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const description = input.description.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

  return `import type { PluginModule } from "@aoagents/ao-core";

export const manifest = {
  name: "${manifestName}",
  slot: "${input.slot}" as const,
  description: "${description}",
  version: "0.1.0",
  displayName: "${displayName}",
};

const plugin: PluginModule = {
  manifest,
  create(config?: Record<string, unknown>) {
    return {
      name: manifest.name,
      config: config ?? {},
      // TODO: replace this placeholder with a real ${input.slot} implementation.
    };
  },
};

export default plugin;
`;
}

function buildReadme(input: PluginScaffoldInput): string {
  const manifestName = normalizePluginName(input.displayName);
  const authorLine = input.author ? `Author: ${input.author}\n\n` : "";
  return `# ${input.displayName}

${input.description}

${authorLine}Package: \`${input.packageName}\`

## Development

\`\`\`bash
npm install
npm run build
\`\`\`

## AO Config

Local development:

\`\`\`yaml
plugins:
  - name: ${manifestName}
    source: local
    path: ./${manifestName}
\`\`\`

Published package:

\`\`\`yaml
plugins:
  - name: ${manifestName}
    source: npm
    package: ${input.packageName}
\`\`\`

## Next Steps

${SLOT_HINTS[input.slot]}
`;
}

export function scaffoldPlugin(input: PluginScaffoldInput): string {
  const targetDir = resolve(input.directory);
  ensureDirectoryIsWritable(targetDir);
  mkdirSync(join(targetDir, "src"), { recursive: true });

  writeFileSync(join(targetDir, "package.json"), buildPackageJson(input), "utf-8");
  writeFileSync(join(targetDir, "tsconfig.json"), buildTsConfig(), "utf-8");
  writeFileSync(join(targetDir, "README.md"), buildReadme(input), "utf-8");
  writeFileSync(join(targetDir, ".gitignore"), "dist/\nnode_modules/\n", "utf-8");
  writeFileSync(join(targetDir, "src", "index.ts"), buildIndexTs(input), "utf-8");

  return targetDir;
}
