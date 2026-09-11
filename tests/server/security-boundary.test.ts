import { describe, expect, it } from "vitest";
import { assertAllowedEgress } from "@/server/security/boundary";

describe("network egress boundary", () => {
  it("allows only reviewed bank and public-rate hosts through application fetch", () => {
    expect(() => assertAllowedEgress("https://api.monobank.ua/personal/statement/0/0")).not.toThrow();
    expect(() => assertAllowedEgress("https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json")).not.toThrow();
    expect(() => assertAllowedEgress("https://api.openai.com/v1/responses")).toThrow("EGRESS_HOST_DENIED");
    expect(() => assertAllowedEgress("https://attacker.invalid/collect")).toThrow("EGRESS_HOST_DENIED");
    expect(() => assertAllowedEgress("http://api.monobank.ua/personal/client-info")).toThrow("EGRESS_TLS_REQUIRED");
  });
});
