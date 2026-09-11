import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";

export interface MoneyWavePaths {
  dataRoot: string;
  databasePath: string;
  backupDirectory: string;
  previewDirectory: string;
  keychainHelperPath: string;
}

export function resolveMoneyWavePaths(configuredRoot = process.env.MONEYWAVE_DATA_DIR): MoneyWavePaths {
  const workspaceRoot = process.cwd();
  const dataRoot = configuredRoot
    ? resolve(/* turbopackIgnore: true */ configuredRoot)
    : join(workspaceRoot, "data", "runtime");
  const unsafeRoots = new Set([parse(dataRoot).root, homedir(), workspaceRoot]);
  if (!isAbsolute(dataRoot) || unsafeRoots.has(dataRoot)) throw new Error("DATA_ROOT_UNSAFE");
  return {
    dataRoot,
    databasePath: join(dataRoot, "moneywave.db"),
    backupDirectory: join(dataRoot, "backups"),
    previewDirectory: join(dataRoot, "previews"),
    keychainHelperPath: join(dataRoot, "bin", "moneywave-keychain"),
  };
}
