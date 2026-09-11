import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { z } from "zod";

import { sanitizeForCategorization, type CategoryClassifier } from "@/domain/categorization";
import { safeMerchantLabel } from "@/domain/personal-categorization";

export const OPENAI_CATEGORY_MODEL = "gpt-5.6-luna";
const MAX_CODEX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BATCH_SIZE = 40;

const categoryResponse = z.object({
  categoryCode: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
}).strict();
const batchCategoryResponse = z.object({ items: z.array(categoryResponse) }).strict();

export interface CodexCategorizationInvocation {
  prompt: string;
  outputSchema: Readonly<Record<string, unknown>>;
}

export type RunCodexCategorization = (invocation: CodexCategorizationInvocation) => Promise<string>;

export function buildCodexExecArgs(input: { workingDirectory: string; schemaPath: string }): string[] {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--strict-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    OPENAI_CATEGORY_MODEL,
    "--json",
    "--color",
    "never",
    "--cd",
    input.workingDirectory,
    "--output-schema",
    input.schemaPath,
    "--config",
    'model_reasoning_effort="low"',
    "--config",
    'web_search="disabled"',
    "--config",
    'approval_policy="never"',
    "--config",
    'shell_environment_policy.inherit="none"',
    "--config",
    "allow_login_shell=false",
    "--config",
    "analytics.enabled=false",
    "--config",
    "check_for_update_on_startup=false",
    "--config",
    "features.apps=false",
    "--config",
    "features.remote_plugin=false",
    "--config",
    "features.multi_agent=false",
    "--config",
    "features.hooks=false",
    "--config",
    "features.memories=false",
    "--config",
    "features.shell_tool=false",
    "--config",
    "features.unified_exec=false",
    "--config",
    "features.browser_use=false",
    "--config",
    "features.browser_use_external=false",
    "--config",
    "features.computer_use=false",
    "--config",
    "features.image_generation=false",
    "--config",
    "features.skill_search=false",
    "--config",
    "features.workspace_dependencies=false",
    "--config",
    "features.goals=false",
    "-",
  ];
}

export function parseCodexJsonl(output: string): string {
  if (Buffer.byteLength(output) > MAX_CODEX_OUTPUT_BYTES) throw new Error("OPENAI_OUTPUT_INVALID");
  let finalResponse: string | undefined;
  try {
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (["command_execution", "mcp_tool_call", "web_search", "computer_use"].includes(event.item?.type ?? "")) {
        throw new Error("OPENAI_TOOL_USE_DENIED");
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        finalResponse = event.item.text;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "OPENAI_TOOL_USE_DENIED") throw error;
    throw new Error("OPENAI_OUTPUT_INVALID");
  }
  if (!finalResponse) throw new Error("OPENAI_OUTPUT_INVALID");
  return finalResponse;
}

function minimalCodexEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    NODE_ENV: "production",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TERM: "dumb",
  };
  if (process.env.CODEX_HOME) environment.CODEX_HOME = process.env.CODEX_HOME;
  if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;
  return environment;
}

function defaultCodexExecutable(): string {
  return join(process.cwd(), "node_modules", ".bin", "codex");
}

async function runProcess(input: {
  executable: string;
  args: readonly string[];
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.args], {
      env: minimalCodexEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("OPENAI_TIMEOUT")));
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_CODEX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("OPENAI_OUTPUT_TOO_LARGE")));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", () => undefined);
    child.once("error", () => finish(() => reject(new Error("OPENAI_RUNTIME_UNAVAILABLE"))));
    child.once("close", (code) => {
      finish(() => code === 0
        ? resolve(Buffer.concat(stdout).toString("utf8"))
        : reject(new Error("OPENAI_RUNTIME_FAILED")));
    });
    child.stdin.once("error", () => undefined);
    child.stdin.end(input.prompt, "utf8");
  });
}

export class EphemeralCodexRunner {
  readonly #executable: string;
  readonly #timeoutMs: number;

  constructor(input: { executable?: string; timeoutMs?: number } = {}) {
    this.#executable = input.executable ?? defaultCodexExecutable();
    this.#timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run(invocation: CodexCategorizationInvocation): Promise<string> {
    const workingDirectory = await mkdtemp(join(tmpdir(), "moneywave-codex-"));
    await chmod(workingDirectory, 0o700);
    const schemaPath = join(workingDirectory, "output.schema.json");
    try {
      await writeFile(schemaPath, JSON.stringify(invocation.outputSchema), { encoding: "utf8", flag: "wx", mode: 0o600 });
      const output = await runProcess({
        executable: this.#executable,
        args: buildCodexExecArgs({ workingDirectory, schemaPath }),
        prompt: invocation.prompt,
        timeoutMs: this.#timeoutMs,
      });
      return parseCodexJsonl(output);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export class CodexSubscriptionCategorizer implements CategoryClassifier {
  readonly #runCodex: RunCodexCategorization;

  constructor(input: { runCodex?: RunCodexCategorization } = {}) {
    const runner = new EphemeralCodexRunner();
    this.#runCodex = input.runCodex ?? ((invocation) => runner.run(invocation));
  }

  async categorize(description: string, allowedCategoryCodes: readonly string[]): Promise<{ categoryCode: string; confidence: number }> {
    const sanitized = sanitizeForCategorization(description).slice(0, 512);
    if (!sanitized) throw new Error("OPENAI_INPUT_EMPTY");
    if (allowedCategoryCodes.length === 0 || allowedCategoryCodes.length > 200) throw new Error("OPENAI_CATEGORIES_INVALID");
    if (allowedCategoryCodes.some((code) => !/^[a-z][a-z0-9_-]{0,63}$/i.test(code))) throw new Error("OPENAI_CATEGORIES_INVALID");

    const outputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["categoryCode", "confidence"],
      properties: {
        categoryCode: { type: "string", enum: [...allowedCategoryCodes] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    } as const;
    const prompt = [
      "Classify one sanitized merchant label into exactly one allowed expense category.",
      "Do not use tools, web search, files, environment variables, or external context.",
      "Do not infer transfers, ownership, fees, amounts, tax treatment, or FX calculations.",
      `Allowed category codes: ${JSON.stringify(allowedCategoryCodes)}`,
      `Sanitized merchant label: ${JSON.stringify(sanitized)}`,
      "Return only the requested JSON object.",
    ].join("\n");

    try {
      const response = await this.#runCodex({ prompt, outputSchema });
      const result = categoryResponse.parse(JSON.parse(response));
      if (!allowedCategoryCodes.includes(result.categoryCode)) throw new Error("category not allowed");
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "OPENAI_INPUT_EMPTY") throw error;
      if (error instanceof Error && error.message === "OPENAI_CATEGORIES_INVALID") throw error;
      if (error instanceof SyntaxError || error instanceof z.ZodError || (error instanceof Error && error.message === "category not allowed")) {
        throw new Error("OPENAI_OUTPUT_INVALID");
      }
      throw new Error("OPENAI_UNAVAILABLE");
    }
  }

  async categorizeBatch(
    merchantLabels: readonly string[],
    allowedCategoryCodes: readonly string[],
  ): Promise<Array<{ categoryCode: string; confidence: number }>> {
    if (merchantLabels.length === 0) return [];
    if (allowedCategoryCodes.length === 0 || allowedCategoryCodes.length > 200) throw new Error("OPENAI_CATEGORIES_INVALID");
    if (allowedCategoryCodes.some((code) => !/^[a-z][a-z0-9_-]{0,63}$/i.test(code))) throw new Error("OPENAI_CATEGORIES_INVALID");
    const output: Array<{ categoryCode: string; confidence: number }> = [];
    for (let offset = 0; offset < merchantLabels.length; offset += MAX_BATCH_SIZE) {
      const sanitized = merchantLabels.slice(offset, offset + MAX_BATCH_SIZE).map((label) => safeMerchantLabel(label));
      if (sanitized.some((label) => !label)) throw new Error("OPENAI_INPUT_EMPTY");
      const outputSchema = {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            minItems: sanitized.length,
            maxItems: sanitized.length,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["categoryCode", "confidence"],
              properties: {
                categoryCode: { type: "string", enum: [...allowedCategoryCodes] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
            },
          },
        },
      } as const;
      const prompt = [
        "Classify each sanitized merchant label into exactly one allowed expense category.",
        "Keep the output items in exactly the same order as the input labels.",
        "Do not use tools, web search, files, environment variables, or external context.",
        "Do not infer transfers, ownership, fees, amounts, tax treatment, or FX calculations.",
        `Allowed category codes: ${JSON.stringify(allowedCategoryCodes)}`,
        `Sanitized merchant labels: ${JSON.stringify(sanitized)}`,
        "Return only the requested JSON object.",
      ].join("\n");
      try {
        const response = await this.#runCodex({ prompt, outputSchema });
        const parsed = batchCategoryResponse.parse(JSON.parse(response));
        if (parsed.items.length !== sanitized.length) throw new Error("batch size invalid");
        for (const item of parsed.items) {
          if (!allowedCategoryCodes.includes(item.categoryCode)) throw new Error("category not allowed");
          output.push(item);
        }
      } catch (error) {
        if (error instanceof Error && ["OPENAI_INPUT_EMPTY", "OPENAI_CATEGORIES_INVALID"].includes(error.message)) throw error;
        if (
          error instanceof SyntaxError
          || error instanceof z.ZodError
          || (error instanceof Error && ["category not allowed", "batch size invalid"].includes(error.message))
        ) throw new Error("OPENAI_OUTPUT_INVALID");
        throw new Error("OPENAI_UNAVAILABLE");
      }
    }
    return output;
  }
}
