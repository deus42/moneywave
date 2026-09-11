import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface BackupRecord {
  path: string;
  createdAt: Date;
}

function monthIndex(date: Date): number {
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

export function selectBackupsForRetention(
  records: readonly BackupRecord[],
  now = new Date(),
): { keep: string[]; remove: string[] } {
  const ordered = [...records].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const keep = new Set(ordered.slice(0, 20).map(({ path }) => path));
  const latestByMonth = new Map<number, BackupRecord>();
  const currentMonth = monthIndex(now);
  for (const record of ordered) {
    const recordMonth = monthIndex(record.createdAt);
    const age = currentMonth - recordMonth;
    if (age < 0 || age >= 12 || latestByMonth.has(recordMonth)) continue;
    latestByMonth.set(recordMonth, record);
  }
  for (const record of latestByMonth.values()) keep.add(record.path);
  return {
    keep: ordered.filter(({ path }) => keep.has(path)).map(({ path }) => path),
    remove: ordered.filter(({ path }) => !keep.has(path)).map(({ path }) => path),
  };
}

export async function enforceBackupRetention(directory: string, now = new Date()): Promise<{
  kept: number;
  removed: number;
}> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const records: BackupRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".backup")) continue;
    const path = join(directory, entry.name);
    const metadata = await stat(path);
    records.push({ path, createdAt: metadata.mtime });
  }
  const selection = selectBackupsForRetention(records, now);
  for (const path of selection.remove) await rm(path, { force: true });
  return { kept: selection.keep.length, removed: selection.remove.length };
}
