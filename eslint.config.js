import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/dist/**",
      "**/dist-server/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/out/**",
      "**/.source/**",
      "**/next-env.d.ts",
      "**/.next-dev/**",
      "**/coverage/**",
      ".ao/**",
      ".claude/**",
      ".context/**",
      ".cursor/**",
      ".expect/**",
      ".gstack/**",
      ".worktrees/**",
      "artifacts/**",
      "packages/web/next-env.d.ts",
      "packages/web/next.config.js",
      "packages/web/postcss.config.mjs",
      "test-clipboard*.mjs",
      "test-clipboard*.sh",
    ],
  },

  // Base JS rules
  eslint.configs.recommended,

  // TypeScript strict rules
  ...tseslint.configs.strict,

  // Prettier compat (disables formatting rules)
  eslintConfigPrettier,

  // Project-wide rules
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Security: prevent shell injection patterns
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",

      // Code quality
      "no-console": "warn",
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "no-template-curly-in-string": "warn",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],

      // TypeScript
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-require-imports": "error",
    },
  },

  // Relaxed rules for test files
  {
    files: ["**/*.test.ts", "**/__tests__/**"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // CLI package uses console.log/error for user output
  {
    files: ["packages/cli/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // Web package uses console for server-side logging
  {
    files: ["packages/web/**/*.ts", "packages/web/**/*.tsx"],
    rules: {
      "no-console": "off",
    },
  },

  // Scripts directory - Node.js environment
  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs", "packages/*/scripts/**/*.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "no-console": "off", // Scripts use console for output
    },
  },

  // ao bin scripts - Node.js environment (postinstall, etc.)
  {
    files: ["packages/ao/bin/**/*.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "no-console": "off", // Bin scripts use console for install output
    },
  },
);
