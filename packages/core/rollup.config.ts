import { readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import type { Plugin, RollupOptions } from "rollup";
import typescript from "@rollup/plugin-typescript";

const externalPackages = new Set(["yaml", "zod"]);
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

function getPackageName(importId: string): string | null {
  if (importId.startsWith(".") || importId.startsWith("/")) {
    return null;
  }

  const parts = importId.split("/");
  return importId.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function rawMarkdown(): Plugin {
  return {
    name: "raw-markdown",
    async load(id: string) {
      if (!id.endsWith(".md")) {
        return null;
      }

      return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
    },
  };
}

function cleanDist(): Plugin {
  return {
    name: "clean-dist",
    async buildStart() {
      await rm("dist", { force: true, recursive: true });
    },
  };
}

const config: RollupOptions = {
  input: {
    index: "src/index.ts",
    "migration/storage-v2": "src/migration/storage-v2.ts",
  },
  output: {
    dir: "dist",
    format: "es",
    preserveModules: true,
    preserveModulesRoot: "src",
    sourcemap: true,
  },
  external(id: string) {
    if (nodeBuiltins.has(id) || id.startsWith("node:")) {
      return true;
    }

    const packageName = getPackageName(id);
    return packageName ? externalPackages.has(packageName) : false;
  },
  plugins: [
    cleanDist(),
    rawMarkdown(),
    typescript({
      compilerOptions: {
        declaration: true,
        declarationMap: true,
        module: "Node16",
      },
      tsconfig: "./tsconfig.build.json",
    }),
  ],
};

export default config;
