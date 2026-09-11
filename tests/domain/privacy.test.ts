import { describe, expect, it } from "vitest";

import { hmacIdentifier, maskIdentifier, normalizeIdentifier } from "@/domain/privacy";

const SYNTHETIC_HMAC_KEY = Buffer.alloc(32, 7);

describe("financial identifier privacy", () => {
  it("normalizes formatting before keyed hashing", () => {
    const compact = hmacIdentifier("UA00 SYNTH ETIC 0001", SYNTHETIC_HMAC_KEY);
    const spaced = hmacIdentifier("ua00-synthetic-0001", SYNTHETIC_HMAC_KEY);
    expect(compact).toBe(spaced);
    expect(compact).toMatch(/^[a-f0-9]{64}$/);
    expect(compact).not.toContain("0001");
    expect(normalizeIdentifier(" ua00-synthetic-0001 ")).toBe("UA00SYNTHETIC0001");
  });

  it("keeps only a non-sensitive display suffix", () => {
    expect(maskIdentifier("UA00 SYNTHETIC 0001")).toBe("•••• 0001");
    expect(maskIdentifier("01")).toBe("••••");
  });
});
