import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { assertAllowedEgress } from "../src/server/security/boundary";

const execFileAsync = promisify(execFile);

interface Check {
  code: string;
  run: () => Promise<boolean>;
}

async function gitOutput(args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

async function ignored(path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", path], { cwd: process.cwd() });
    return true;
  } catch {
    return false;
  }
}

const checks: Check[] = [
  {
    code: "SENSITIVE_PATH_IGNORE",
    run: async () => (await Promise.all([
      "data/privatebank/synthetic-check.xlsx",
      "data/runtime/synthetic-check.db",
      "data/backups/synthetic-check.backup",
      "data/exports/synthetic-check.csv",
      ".env.local",
      "tasks/worklogs/synthetic-check.md",
    ].map(ignored))).every(Boolean),
  },
  {
    code: "DOCUMENTATION_TRACKABLE",
    run: async () => !(await ignored("data/README.md")) && !(await ignored("tasks/worklogs/README.md")),
  },
  {
    code: "NO_SENSITIVE_CANDIDATES",
    run: async () => {
      const files = (await gitOutput(["ls-files", "--cached", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
      return files.every((path) => (
        (!path.startsWith("data/") || path === "data/README.md")
        && (!path.startsWith("tasks/worklogs/") || path === "tasks/worklogs/README.md")
        && !/\.(?:csv|ofx|qfx|qbo|mt940|xls|xlsx|pdf|db|sqlite|backup)$/i.test(path)
      ));
    },
  },
  {
    code: "EGRESS_BOUNDARY",
    run: async () => {
      assertAllowedEgress("https://bank.gov.ua/");
      for (const denied of ["https://synthetic.invalid/", "http://bank.gov.ua/"]) {
        try { assertAllowedEgress(denied); return false; } catch { /* expected denial */ }
      }
      return true;
    },
  },
  {
    code: "NO_DIRECT_OPENAI_FETCH",
    run: async () => {
      const files = (await gitOutput(["ls-files", "--cached", "--others", "--exclude-standard", "src"])).split("\n").filter(Boolean);
      const contents = await Promise.all(files.filter((path) => /\.[cm]?[jt]sx?$/.test(path)).map((path) => readFile(path, "utf8")));
      return contents.every((content) => !content.includes("api.openai.com") && !content.includes("dangerouslySetInnerHTML") && !/\beval\s*\(/.test(content));
    },
  },
  {
    code: "CODEX_EPHEMERAL_BOUNDARY",
    run: async () => {
      const source = await readFile("src/server/categorization/codex-subscription.ts", "utf8");
      return ["--ephemeral", "--ignore-user-config", "read-only", 'web_search="disabled"', 'shell_environment_policy.inherit="none"']
        .every((required) => source.includes(required));
    },
  },
  {
    code: "NO_TELEMETRY_DEPENDENCIES",
    run: async () => {
      const packageJson = await readFile("package.json", "utf8");
      return !packageJson.includes("posthog") && !packageJson.includes("sentry");
    },
  },
];

let failed = false;
for (const [index, check] of checks.entries()) {
  let passed = false;
  try {
    passed = await check.run();
  } catch {
    passed = false;
  }
  failed ||= !passed;
  process.stdout.write(`security_check_${index + 1} ${passed ? "PASS" : `FAIL ${check.code}`}\n`);
}
if (failed) process.exitCode = 1;
