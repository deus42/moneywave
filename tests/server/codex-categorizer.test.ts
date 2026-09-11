import { describe, expect, it, vi } from "vitest";

import {
  CodexSubscriptionCategorizer,
  buildCodexExecArgs,
  parseCodexJsonl,
  type CodexCategorizationInvocation,
} from "@/server/categorization/codex-subscription";

describe("OpenAI categorization through the user's Codex subscription", () => {
  it("sends only sanitized merchant text and validates structured output", async () => {
    const runCodex = vi.fn(async (invocation: CodexCategorizationInvocation) => {
      expect(invocation.prompt).toContain("SYNTHETIC MERCHANT");
      expect(invocation.prompt).not.toMatch(/4444333322221111|UA0012345678901234567890123456|123\.45|ABC-123/);
      expect(invocation.prompt).not.toMatch(/\d/);
      expect(invocation.outputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: {
          categoryCode: { enum: ["food", "other"] },
        },
      });
      return JSON.stringify({ categoryCode: "food", confidence: 0.91 });
    });
    const categorizer = new CodexSubscriptionCategorizer({ runCodex });

    const result = await categorizer.categorize(
      "SYNTHETIC MERCHANT UA0012345678901234567890123456 4444333322221111 ref ABC-123 123.45 UAH",
      ["food", "other"],
    );

    expect(result).toEqual({ categoryCode: "food", confidence: 0.91 });
    expect(runCodex).toHaveBeenCalledOnce();
  });

  it("maps invalid output and unavailable subscription runtime to safe codes", async () => {
    const invalid = new CodexSubscriptionCategorizer({
      runCodex: async () => JSON.stringify({ categoryCode: "invented", confidence: 0.99 }),
    });
    await expect(invalid.categorize("SYNTHETIC MERCHANT", ["food", "other"]))
      .rejects.toThrow("OPENAI_OUTPUT_INVALID");

    const unavailable = new CodexSubscriptionCategorizer({
      runCodex: async () => { throw new Error("arbitrary child process detail"); },
    });
    await expect(unavailable.categorize("SYNTHETIC MERCHANT", ["food", "other"]))
      .rejects.toThrow("OPENAI_UNAVAILABLE");
  });

  it("categorizes a bounded batch in one ephemeral subscription call", async () => {
    const runCodex = vi.fn(async (invocation: CodexCategorizationInvocation) => {
      expect(invocation.prompt).toContain("SYNTHETIC CAFE");
      expect(invocation.prompt).toContain("SYNTHETIC TAXI");
      expect(invocation.prompt).not.toMatch(/4444333322221111|123\.45|ABC-123/);
      expect(invocation.outputSchema).toMatchObject({
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 2,
            maxItems: 2,
          },
        },
      });
      return JSON.stringify({
        items: [
          { categoryCode: "dining", confidence: 0.93 },
          { categoryCode: "taxi", confidence: 0.96 },
        ],
      });
    });
    const categorizer = new CodexSubscriptionCategorizer({ runCodex });

    await expect(categorizer.categorizeBatch([
      "SYNTHETIC CAFE card 4444333322221111 ref ABC-123 123.45 UAH",
      "SYNTHETIC TAXI",
    ], ["dining", "taxi", "other"])).resolves.toEqual([
      { categoryCode: "dining", confidence: 0.93 },
      { categoryCode: "taxi", confidence: 0.96 },
    ]);
    expect(runCodex).toHaveBeenCalledOnce();
  });
});

describe("ephemeral Codex process boundary", () => {
  it("uses the subscription model without persisting a thread or exposing the prompt in argv", () => {
    const args = buildCodexExecArgs({
      workingDirectory: "/private/tmp/moneywave-ai-synthetic",
      schemaPath: "/private/tmp/moneywave-ai-synthetic/output.schema.json",
    });

    expect(args).toEqual(expect.arrayContaining([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--strict-config",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-5.6-luna",
      "--json",
      "-",
    ]));
    expect(args.join(" ")).toContain('web_search="disabled"');
    expect(args.join(" ")).toContain('shell_environment_policy.inherit="none"');
    expect(args.join(" ")).toContain("features.apps=false");
    expect(args.join(" ")).toContain("features.shell_tool=false");
    expect(args.join(" ")).toContain("features.unified_exec=false");
    expect(args.join(" ")).toContain("features.multi_agent=false");
    expect(args.join(" ")).toContain("analytics.enabled=false");
    expect(args.join(" ")).not.toContain("SYNTHETIC MERCHANT");
  });

  it("extracts only the final structured assistant message from bounded JSONL", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "synthetic-thread" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "ignored" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"categoryCode":"food","confidence":0.88}' } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join("\n");

    expect(parseCodexJsonl(output)).toBe('{"categoryCode":"food","confidence":0.88}');
    expect(() => parseCodexJsonl("not-json")).toThrow("OPENAI_OUTPUT_INVALID");
    expect(() => parseCodexJsonl([
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "synthetic" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"categoryCode":"food","confidence":0.88}' } }),
    ].join("\n"))).toThrow("OPENAI_TOOL_USE_DENIED");
  });
});
