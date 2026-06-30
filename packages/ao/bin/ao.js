#!/usr/bin/env node
// Pure-Node shim: resolve the per-platform optionalDependency that holds the
// prebuilt Go `ao` binary for this host, then exec it transparently.
// Zero install scripts; zero third-party deps. The binary is delivered by npm
// installing only the matching `@aoagents/ao-<platform>-<arch>` package (its
// os/cpu fields gate the rest out).

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

// npm cpu names match process.arch (x64/arm64); npm os names match
// process.platform (darwin/win32/linux). Our platform packages are named
// `@aoagents/ao-<platform>-<arch>` to mirror that exactly.
const platform = process.platform;
const arch = process.arch;
const pkg = `@aoagents/ao-${platform}-${arch}`;
const binName = platform === "win32" ? "ao.exe" : "ao";

function resolveBinary() {
  // require.resolve the platform package's package.json to find its install
  // dir (works whether hoisted to a parent node_modules or nested), then join
  // the binary path. The platform package ships the binary under bin/.
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve(`${pkg}/package.json`);
  } catch {
    return null;
  }
  return path.join(path.dirname(pkgJsonPath), "bin", binName);
}

const binary = resolveBinary();

if (!binary) {
  process.stderr.write(
    `@aoagents/ao: no prebuilt binary for ${platform}-${arch}.\n` +
      `The optional dependency ${pkg} is not installed, which usually means\n` +
      `this platform is unsupported. Supported: darwin-arm64, darwin-x64,\n` +
      `win32-x64, linux-x64.\n`,
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  if (result.error.code === "ENOENT") {
    process.stderr.write(
      `@aoagents/ao: binary not found at ${binary}.\n` +
        `Reinstall @aoagents/ao to restore the platform package.\n`,
    );
  } else {
    process.stderr.write(`@aoagents/ao: failed to run binary: ${result.error.message}\n`);
  }
  process.exit(1);
}

// Propagate signal-terminations as a conventional 128+signal code, else the
// child's own exit code.
if (result.signal) {
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
