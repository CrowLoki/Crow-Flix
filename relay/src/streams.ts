/** Small stream helpers shared by the relay routes and the EPG pipeline. */

export function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

export interface BoundedRead {
  data: Uint8Array;
  /** True when the cap was hit and the rest of the body was discarded. */
  truncated: boolean;
}

/**
 * Read a body fully, but never retain more than `cap` bytes. When the cap
 * is exceeded the upstream reader is cancelled so we stop pulling bytes.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array>,
  cap: number,
): Promise<BoundedRead> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > cap) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { data: concatChunks(chunks, total), truncated };
}
