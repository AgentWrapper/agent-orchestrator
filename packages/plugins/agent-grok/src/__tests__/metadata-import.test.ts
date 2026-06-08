import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { manifest } from "../index.js";

const testFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(testFilePath), "../..");
const sourcePath = path.join(packageRoot, "src/index.ts");

const forbiddenPackageMetadataLookups = [
  "createRequire(import.meta.url)",
  'require("../package.json")',
  'readFileSync(new URL("../package.json", import.meta.url))',
];

function assertPackageMetadataImportPattern(label: string, source: string): void {
  for (const forbidden of forbiddenPackageMetadataLookups) {
    expect(source, `${label} must not contain ${forbidden}`).not.toContain(forbidden);
  }

  const packageJsonImports = [...source.matchAll(/from\s+["']\.\.\/package\.json["'][^;]*/g)].map(
    (match) => match[0],
  );

  expect(packageJsonImports.length, `${label} imports ../package.json`).toBeGreaterThan(0);
  for (const importStatement of packageJsonImports) {
    expect(
      importStatement,
      `${label} package.json import must use a JSON import attribute`,
    ).toMatch(/\swith\s*\{\s*type:\s*["']json["']\s*\}/);
  }
}

function compileAgentGrokTo(outDir: string): void {
  const configPath = path.join(packageRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext([configFile.error], {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getNewLine: () => ts.sys.newLine,
      }),
    );
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    packageRoot,
    {
      declaration: false,
      declarationMap: false,
      outDir,
      sourceMap: false,
    },
    configPath,
  );

  const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
  const emitResult = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
  if (emitResult.emitSkipped || diagnostics.length > 0) {
    const message =
      diagnostics.length > 0
        ? ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCanonicalFileName: (fileName) => fileName,
            getCurrentDirectory: ts.sys.getCurrentDirectory,
            getNewLine: () => ts.sys.newLine,
          })
        : "TypeScript emit skipped without diagnostics.";
    throw new Error(message);
  }
}

describe("package metadata import", () => {
  it("keeps manifest version in sync with package.json", () => {
    expect(manifest.version).toBe(packageJson.version);
  });

  it("uses JSON import attributes in the source runtime module", async () => {
    const source = await readFile(sourcePath, "utf8");
    assertPackageMetadataImportPattern("src/index.ts", source);
  });

  it("uses JSON import attributes in the compiled runtime module", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "ao-agent-grok-"));

    try {
      compileAgentGrokTo(outDir);
      const compiledSource = await readFile(path.join(outDir, "index.js"), "utf8");
      assertPackageMetadataImportPattern("compiled index.js", compiledSource);
    } finally {
      await rm(outDir, { force: true, recursive: true });
    }
  });
});
