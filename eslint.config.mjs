import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...tseslint.configs.recommended,
  {
    files: ["src/web/**/*.js"],
    languageOptions: {
      globals: Object.fromEntries([
        "CSS", "FormData", "URLSearchParams", "crypto", "document", "fetch",
        "history", "location", "setTimeout", "structuredClone", "window",
      ].map(name => [name, "readonly"])),
    },
    rules: { "no-undef": "error" },
  },
  globalIgnores([".next/**", ".cache/**", ".superpowers/**", "data/**", "tasks/worklogs/**", "coverage/**", "playwright-report/**", "test-results/**"]),
]);
