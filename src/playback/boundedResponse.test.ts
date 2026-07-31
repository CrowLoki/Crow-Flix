import { describe, expect, it, vi } from "vitest";
import {
  declaredResponseLength,
  readBoundedResponse,
  ResponseBodyUnavailableError,
  ResponseSizeLimitError,
} from "./boundedResponse";

describe("bounded playback responses", () => {
  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "content-length": "5" },
    });

    await expect(readBoundedResponse(response, 4, "The media response"))
      .rejects.toBeInstanceOf(ResponseSizeLimitError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a streamed response that exceeds the limit without Content-Length", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    }));

    await expect(readBoundedResponse(response, 4, "The media response"))
      .rejects.toMatchObject({
        code: "RESPONSE_TOO_LARGE",
        maximumBytes: 4,
      });
    expect(cancelled).toBe(true);
  });

  it("returns the complete body at the exact limit", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-length": "4" },
    });

    const buffer = await readBoundedResponse(response, 4, "The media response");
    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3, 4]);
    expect(declaredResponseLength(response)).toBe(4);
  });

  it("rejects a declared non-empty response without a readable body", async () => {
    const response = new Response(null, {
      headers: { "content-length": "1" },
    });

    await expect(readBoundedResponse(response, 4, "The media response"))
      .rejects.toBeInstanceOf(ResponseBodyUnavailableError);
  });
});
