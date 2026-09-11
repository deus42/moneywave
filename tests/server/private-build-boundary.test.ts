import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("application build private-file boundary", () => {
  it("does not typecheck private audits, exports or task snapshots as product code", () => {
    const config = JSON.parse(readFileSync("tsconfig.json", "utf8"));
    expect(config.exclude).toEqual(expect.arrayContaining(["data", "tasks/worklogs", ".superpowers"]));
  });
});
