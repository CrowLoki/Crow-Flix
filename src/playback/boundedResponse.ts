const MEBIBYTE = 1024 * 1024;

export const MAX_PLAYBACK_METADATA_BYTES = 4 * MEBIBYTE;
export const MAX_PLAYBACK_MEDIA_BYTES = 64 * MEBIBYTE;

export class ResponseSizeLimitError extends Error {
  readonly code = "RESPONSE_TOO_LARGE";
  readonly maximumBytes: number;

  constructor(label: string, maximumBytes: number) {
    super(`${label} is larger than CrowFlix's ${formatByteLimit(maximumBytes)} safety limit.`);
    this.name = "ResponseSizeLimitError";
    this.maximumBytes = maximumBytes;
  }
}

export class ResponseBodyUnavailableError extends Error {
  readonly code = "RESPONSE_BODY_UNAVAILABLE";

  constructor(label: string) {
    super(`${label} did not provide a readable response body.`);
    this.name = "ResponseBodyUnavailableError";
  }
}

export function playbackResponseLimit(
  responseType: string | undefined,
): number {
  return responseType === "arraybuffer" || responseType === "blob"
    ? MAX_PLAYBACK_MEDIA_BYTES
    : MAX_PLAYBACK_METADATA_BYTES;
}

export function declaredResponseLength(response: Response): number | null {
  const raw = response.headers.get("content-length")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Rejects a streamed payload as soon as it exceeds maximumBytes and never
 * concatenates an oversized body. The bounded chunks and final contiguous
 * buffer briefly coexist on success, so peak application memory can approach
 * twice the byte limit. Content-Length is only an early rejection because
 * servers and transparent decompression can make it wrong.
 */
export async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<ArrayBuffer> {
  const declaredLength = declaredResponseLength(response);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseSizeLimitError(label, maximumBytes);
  }

  if (!response.body) {
    if (declaredLength !== null && declaredLength > 0) {
      throw new ResponseBodyUnavailableError(label);
    }
    return new ArrayBuffer(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!value?.byteLength) continue;
      const nextLength = length + value.byteLength;
      if (!Number.isSafeInteger(nextLength) || nextLength > maximumBytes) {
        throw new ResponseSizeLimitError(label, maximumBytes);
      }
      chunks.push(value);
      length = nextLength;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

export function safePlaybackReadError(error: unknown): string {
  return error instanceof ResponseSizeLimitError
    || error instanceof ResponseBodyUnavailableError
    ? error.message
    : "Network response could not be read";
}

function formatByteLimit(bytes: number): string {
  return bytes % MEBIBYTE === 0
    ? `${bytes / MEBIBYTE} MiB`
    : `${bytes.toLocaleString()} bytes`;
}
