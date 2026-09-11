import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores([".next/**", ".cache/**", ".superpowers/**", "data/**", "tasks/worklogs/**", "coverage/**", "playwright-report/**", "test-results/**"]),
]);
