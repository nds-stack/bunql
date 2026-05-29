/**
 * /eslint.config.js
 * ESLint configuration for bunql.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "bench/", "test/", "bench/node-*.cjs", "bench/deno-sqlite.ts", "test/tmp/", "bench/tmp/"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-this-alias": "off",
      "no-unused-private-class-members": "off",
      "no-useless-assignment": "off",
      "no-control-regex": "off",
      "no-empty": "warn",
      "prefer-const": "warn",
      "no-console": "warn",
    },
  },
];