#!/usr/bin/env python3
"""Check built-in AO agent plugin wiring for one slug.

Run from the repository root:
  python3 skills/ao-agent-plugin-builder/scripts/check_agent_plugin_wiring.py kimicode
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def slug_to_import_name(slug: str) -> str:
    parts = re.split(r"[^a-zA-Z0-9]+", slug)
    return "pluginAgent" + "".join(part.capitalize() for part in parts if part)


class Checker:
    def __init__(self, root: Path, slug: str, package_name: str) -> None:
        self.root = root
        self.slug = slug
        self.package_name = package_name
        self.failures: list[str] = []
        self.warnings: list[str] = []

    def path(self, rel: str) -> Path:
        return self.root / rel

    def read(self, rel: str) -> str:
        return self.path(rel).read_text(encoding="utf-8")

    def require(self, condition: bool, message: str) -> None:
        if condition:
            print(f"PASS {message}")
        else:
            print(f"FAIL {message}")
            self.failures.append(message)

    def warn_if_missing(self, condition: bool, message: str) -> None:
        if condition:
            print(f"PASS {message}")
        else:
            print(f"WARN {message}")
            self.warnings.append(message)

    def check_package(self) -> None:
        base = self.path(f"packages/plugins/agent-{self.slug}")
        self.require(base.is_dir(), f"packages/plugins/agent-{self.slug}/ exists")
        package_json_path = base / "package.json"
        self.require(package_json_path.is_file(), "package.json exists")
        if package_json_path.is_file():
            data = json.loads(package_json_path.read_text(encoding="utf-8"))
            self.require(data.get("name") == self.package_name, f"package name is {self.package_name}")
            self.require(data.get("type") == "module", "package is ESM")
            self.require(data.get("main") == "dist/index.js", "main points at dist/index.js")
            self.require(data.get("types") == "dist/index.d.ts", "types points at dist/index.d.ts")
            scripts = data.get("scripts", {})
            for script in ("build", "typecheck", "test", "clean"):
                self.require(script in scripts, f"package script '{script}' exists")
            deps = data.get("dependencies", {})
            self.require(
                deps.get("@aoagents/ao-core") == "workspace:*",
                "depends on @aoagents/ao-core workspace:*",
            )
        tsconfig_path = base / "tsconfig.json"
        self.require(tsconfig_path.is_file(), "tsconfig.json exists")
        if tsconfig_path.is_file():
            tsconfig = json.loads(tsconfig_path.read_text(encoding="utf-8"))
            self.require(
                tsconfig.get("extends") == "../../../tsconfig.node.json",
                "tsconfig extends ../../../tsconfig.node.json",
            )
        self.require((base / "src" / "index.ts").is_file(), "src/index.ts exists")
        self.require((base / "src" / "index.test.ts").is_file(), "src/index.test.ts exists")

    def check_index(self) -> None:
        rel = f"packages/plugins/agent-{self.slug}/src/index.ts"
        path = self.path(rel)
        if not path.is_file():
            return
        text = path.read_text(encoding="utf-8")
        self.require(f'name: "{self.slug}"' in text, "manifest.name matches slug")
        self.require('slot: "agent" as const' in text, "manifest.slot is agent")
        self.require("type Agent" in text or ", Agent" in text, "imports Agent type")
        self.require("type PluginModule" in text or ", PluginModule" in text, "imports PluginModule type")
        self.require("getLaunchCommand(" in text, "implements getLaunchCommand")
        self.require("getEnvironment(" in text, "implements getEnvironment")
        self.require("detectActivity(" in text, "implements detectActivity")
        self.require("getActivityState(" in text, "implements getActivityState")
        self.require("isProcessRunning(" in text, "implements isProcessRunning")
        self.require("getSessionInfo(" in text, "implements getSessionInfo")
        self.require("export function create" in text, "exports create()")
        self.require("export function detect" in text, "exports detect()")
        self.require("satisfies PluginModule<Agent>" in text, "default export satisfies PluginModule<Agent>")
        self.require("shellEscape" in text, "uses shellEscape for launch args")

    def check_central_wiring(self) -> None:
        cli_package = json.loads(self.read("packages/cli/package.json"))
        deps = cli_package.get("dependencies", {})
        self.require(deps.get(self.package_name) == "workspace:*", "packages/cli/package.json has workspace dependency")

        registry = self.read("packages/core/src/plugin-registry.ts")
        registry_pattern = (
            rf'\{{\s*slot:\s*"agent",\s*name:\s*"{re.escape(self.slug)}",'
            rf'\s*pkg:\s*"{re.escape(self.package_name)}"\s*\}}'
        )
        self.require(re.search(registry_pattern, registry) is not None, "core BUILTIN_PLUGINS includes agent")

        detect_agent = self.read("packages/cli/src/lib/detect-agent.ts")
        detect_pattern = (
            rf'\{{\s*name:\s*"{re.escape(self.slug)}",'
            rf'\s*pkg:\s*"{re.escape(self.package_name)}"\s*\}}'
        )
        self.require(re.search(detect_pattern, detect_agent) is not None, "CLI AGENT_PLUGINS includes agent")

        services = self.read("packages/web/src/lib/services.ts")
        import_name = slug_to_import_name(self.slug)
        self.require(self.package_name in services, "web services statically import package")
        self.require(f"registry.register({import_name})" in services, f"web services register {import_name}")

        marketplace = self.read("packages/cli/src/assets/plugin-registry.json")
        self.warn_if_missing(
            self.package_name in marketplace,
            "marketplace catalog includes package when installer-visible",
        )

        start_ts = self.read("packages/cli/src/commands/start.ts")
        self.warn_if_missing(
            f'id: "{self.slug}"' in start_ts,
            "ao start install options include agent when install command is known",
        )

    def run(self) -> int:
        self.check_package()
        self.check_index()
        self.check_central_wiring()
        print()
        print(f"Summary: {len(self.failures)} failure(s), {len(self.warnings)} warning(s)")
        if self.failures:
            return 1
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check built-in AO agent plugin wiring for one slug.",
    )
    parser.add_argument("slug", help="agent slug, e.g. kimicode or amp")
    parser.add_argument(
        "--package-name",
        help="expected package name (default: @aoagents/ao-plugin-agent-{slug})",
    )
    parser.add_argument(
        "--root",
        default=".",
        help="repository root (default: current directory)",
    )
    args = parser.parse_args()

    slug = args.slug.strip().lower()
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
        print("slug must be lowercase hyphen-case", file=sys.stderr)
        return 2

    root = Path(args.root).resolve()
    package_name = args.package_name or f"@aoagents/ao-plugin-agent-{slug}"
    return Checker(root, slug, package_name).run()


if __name__ == "__main__":
    raise SystemExit(main())
