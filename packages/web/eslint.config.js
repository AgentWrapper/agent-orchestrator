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
];
