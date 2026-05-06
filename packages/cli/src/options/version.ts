import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function getCliVersion(): string {
  const packageJson = require("../../package.json") as { version: string };
  return packageJson.version;
}
