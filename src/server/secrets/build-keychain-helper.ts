import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SOURCE_PATH = fileURLToPath(new URL("../../../tools/keychain-helper.swift", import.meta.url));

export async function buildKeychainHelper(outputPath: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("KEYCHAIN_PLATFORM_UNSUPPORTED");
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  try {
    await execFileAsync("/usr/bin/xcrun", ["swiftc", SOURCE_PATH, "-framework", "Security", "-o", outputPath], {
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    await chmod(outputPath, 0o700);
  } catch {
    throw new Error("KEYCHAIN_HELPER_BUILD_FAILED");
  }
}
