import { CodexSubscriptionCategorizer } from "../src/server/categorization/codex-subscription";

try {
  const result = await new CodexSubscriptionCategorizer().categorize("SYNTHETIC CAFE", ["food", "other"]);
  if (!new Set(["food", "other"]).has(result.categoryCode)) throw new Error("OPENAI_OUTPUT_INVALID");
  process.stdout.write("codex_subscription_synthetic PASS\n");
} catch (error) {
  const code = error instanceof Error && /^OPENAI_[A-Z0-9_]+$/.test(error.message) ? error.message : "OPENAI_UNAVAILABLE";
  process.stdout.write(`codex_subscription_synthetic FAIL ${code}\n`);
  process.exitCode = 1;
}
