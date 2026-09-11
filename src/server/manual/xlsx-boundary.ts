/** Check ZIP directory budgets before SheetJS expands workbook XML. No extraction. */
export function assertBoundedXlsx(bytes: Buffer): void {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length) throw new Error("MANUAL_ARCHIVE_INVALID");
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const offset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || count !== bytes.readUInt16LE(end + 8) || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
    || offset + size !== end || !count || count > 1000) throw new Error("MANUAL_ARCHIVE_INVALID");
  let cursor = offset;
  let expandedBytes = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("MANUAL_ARCHIVE_INVALID");
    const expanded = bytes.readUInt32LE(cursor + 24);
    const compressed = bytes.readUInt32LE(cursor + 20);
    expandedBytes += expanded;
    if (expanded > 32 * 1024 * 1024 || expandedBytes > 64 * 1024 * 1024) throw new Error("MANUAL_ARCHIVE_LIMIT");
    const local = bytes.readUInt32LE(cursor + 42);
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50
      || local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28) + compressed > offset
      || bytes.readUInt16LE(cursor + 8) & 1) throw new Error("MANUAL_ARCHIVE_INVALID");
    cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  if (cursor !== end) throw new Error("MANUAL_ARCHIVE_INVALID");
}
