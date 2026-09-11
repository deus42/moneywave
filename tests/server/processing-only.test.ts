import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("framework-independent finance processing", () => {
  it("retains the processing core without introducing a web framework", () => {
    for (const path of ["src/app", "src/lib/client-api.ts", "src/proxy.ts", "next.config.ts", "next-env.d.ts", "playwright.config.ts"]) {
      expect(existsSync(path), path).toBe(false);
    }
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(manifest.scripts).not.toHaveProperty("start");
    expect(existsSync("src/web/index.html")).toBe(false);
    for (const name of ["next", "react", "react-dom", "eslint-config-next", "@types/react", "@types/react-dom", "@playwright/test"]) expect(dependencies).not.toHaveProperty(name);
    for (const name of ["dev", "build", "test:e2e", "e2e:reset"]) expect(manifest.scripts).not.toHaveProperty(name);
  });

  it("retains the local finance operators", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    for (const name of ["analyze:finance", "analyze:privatebank", "import:manual-positions", "keychain:build", "verify:real-data"]) expect(manifest.scripts[name]).toBeTruthy();
    for (const path of ["scripts/import-foreign-statements.ts", "src/server/runtime/services.ts", "src/server/db/database.ts", "src/server/import/service.ts", "src/server/cash/service.ts", "src/server/analysis/autonomous-analysis.ts", "src/server/read-model/repository.ts"]) expect(existsSync(path), path).toBe(true);
  });

  it("keeps processing independent of web framework imports", () => {
    function scan(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (/\.[cm]?tsx?$/.test(entry.name)) {
          expect(readFileSync(path, "utf8"), path).not.toMatch(/(?:from\s+|import\s*\()["'](?:next(?:\/|["'])|react(?:-dom)?(?:\/|["'])|@\/(?:app|ui|lib\/client-api))/);
        }
      }
    }
    scan("src");
    scan("scripts");
  });
});
