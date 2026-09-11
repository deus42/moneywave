export async function withZeroedBuffer<Result>(
  bytes: Buffer,
  operation: (bytes: Buffer) => Promise<Result>,
): Promise<Result> {
  try {
    return await operation(bytes);
  } finally {
    bytes.fill(0);
  }
}
