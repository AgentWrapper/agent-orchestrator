import nextPlugin from "@next/eslint-plugin-next";
import rootConfig from "../../eslint.config.js";

export default [
  ...rootConfig,
  {
    ignores: ["next-env.d.ts", "next.config.js", "postcss.config.mjs"],
  },
  {
    plugins: { "@next/next": nextPlugin },
    settings: { next: { rootDir: "." } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      "@next/next/no-html-link-for-pages": "off",
      "no-console": "off",
    },
  },

  // C-04 migration ratchet (web offenders). Paths are relative to this config
  // file (i.e. `packages/web/`), matching how flat config resolves `files`.
  //
  // Tracked by open split issues:
  //   src/components/SessionDetail.tsx → #770
  //   src/components/DirectTerminal.tsx → #769
  //
  // Remaining offenders (no split issue yet — good candidates for future refactors):
  //   server/mux-websocket.ts
  //   src/app/{dev/terminal-test/page,sessions/[id]/page}.tsx
  //   src/components/{Dashboard,SessionCard,ProjectSidebar}.tsx
  //   src/lib/{serialize,types}.ts
  {
    files: [
      // Known offenders with open split issues
      "src/components/SessionDetail.tsx",
      "src/components/DirectTerminal.tsx",

      // Other existing offenders (grandfathered — no split issue yet)
      "server/mux-websocket.ts",
      "src/app/dev/terminal-test/page.tsx",
      "src/app/sessions/[[]id[]]/page.tsx", // [id] escaped — brackets are glob character classes
      "src/components/Dashboard.tsx",
      "src/components/SessionCard.tsx",
      "src/components/ProjectSidebar.tsx",
      "src/lib/serialize.ts",
      "src/lib/types.ts",
    ],
    rules: {
      "max-lines": "off",
    },
  },
];
