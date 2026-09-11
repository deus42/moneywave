import { describe, expect, it } from "vitest";

import { withZeroedBuffer } from "@/server/security/sensitive-buffer";

describe("sensitive buffer lifetime", () => {
  it("keeps bytes available until an asynchronous consumer settles, then wipes them", async () => {
    const bytes = Buffer.from("SYNTHETIC_STATEMENT");
    const expected = Buffer.from(bytes);

    const observed = await withZeroedBuffer(bytes, async (value) => {
      await Promise.resolve();
      return Buffer.from(value);
    });

    expect(observed).toEqual(expected);
    expect(bytes.equals(Buffer.alloc(bytes.byteLength))).toBe(true);
  });

  it("also wipes bytes when the asynchronous consumer rejects", async () => {
    const bytes = Buffer.from("SYNTHETIC_STATEMENT");

    await expect(withZeroedBuffer(bytes, async () => {
      await Promise.resolve();
      throw new Error("SYNTHETIC_FAILURE");
    })).rejects.toThrow("SYNTHETIC_FAILURE");

    expect(bytes.equals(Buffer.alloc(bytes.byteLength))).toBe(true);
  });
});
