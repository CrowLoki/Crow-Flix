import { describe, expect, it, vi } from "vitest";
import {
  createMediaFetcher,
  DEFAULT_NATIVE_USER_AGENT,
  probeSource,
  type FetchImplementation,
} from "./nativeFetch";
import type { StreamSource } from "./types";

const protectedSource: StreamSource = {
  id: "protected",
  url: "https://provider.test/live",
  userAgent: "CrowFlix Test Agent",
  referrer: "https://provider.test/watch",
};

describe("createMediaFetcher", () => {
  it("passes native source headers, ranges and the caller abort signal", async () => {
    let receivedInit: (RequestInit & { maxRedirections?: number }) | undefined;
    const native: FetchImplementation = vi.fn(async (_input, init) => {
      receivedInit = init;
      return new Response("#EXTM3U");
    });
    const browser = vi.fn(async () => new Response());
    const fetcher = createMediaFetcher(native, browser, () => true);
    const controller = new AbortController();

    await fetcher(protectedSource.url, protectedSource, {
      headers: { Range: "bytes=0-4095" },
      signal: controller.signal,
    });
    controller.abort();

    const headers = new Headers(receivedInit?.headers);
    expect(headers.get("User-Agent")).toBe("CrowFlix Test Agent");
    expect(headers.get("Referer")).toBe("https://provider.test/watch");
    expect(headers.get("Origin")).toBe("");
    expect(headers.get("Range")).toBe("bytes=0-4095");
    expect(receivedInit?.signal).toBe(controller.signal);
    expect(receivedInit?.signal?.aborted).toBe(true);
    expect(browser).not.toHaveBeenCalled();
  });

  it("does not synthesize restricted headers in browser preview", async () => {
    let receivedInit: RequestInit | undefined;
    const native: FetchImplementation = vi.fn(async () => new Response());
    const browser = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedInit = init;
      return new Response();
    });
    const fetcher = createMediaFetcher(native, browser, () => false);

    await fetcher(protectedSource.url, protectedSource, {
      headers: { Range: "bytes=0-4095" },
    });

    const headers = new Headers(receivedInit?.headers);
    expect(headers.get("User-Agent")).toBeNull();
    expect(headers.get("Referer")).toBeNull();
    expect(headers.get("Origin")).toBeNull();
    expect(headers.get("Range")).toBe("bytes=0-4095");
    expect(native).not.toHaveBeenCalled();
  });

  it("uses a browser-like default User-Agent for native requests without a source override", async () => {
    let receivedInit: RequestInit | undefined;
    const native: FetchImplementation = vi.fn(async (_input, init) => {
      receivedInit = init;
      return new Response();
    });
    const fetcher = createMediaFetcher(native, vi.fn(), () => true);

    await fetcher("https://provider.test/live.m3u8", {
      id: "ordinary",
      url: "https://provider.test/live.m3u8",
    });

    const userAgent = new Headers(receivedInit?.headers).get("User-Agent");
    expect(userAgent).toBe(DEFAULT_NATIVE_USER_AGENT);
    expect(userAgent).toContain("Windows NT 10.0");
    expect(userAgent).toContain("Chrome/");
  });
});

describe("probeSource", () => {
  it("uses a bounded byte range and classifies an extensionless manifest", async () => {
    let receivedRange: string | null = null;
    const fetcher = vi.fn(async (_url: string, _source: StreamSource, init?: RequestInit) => {
      receivedRange = new Headers(init?.headers).get("Range");
      return new Response("#EXTM3U\n#EXT-X-VERSION:3", {
        status: 206,
        headers: { "content-type": "application/octet-stream" },
      });
    });

    const result = await probeSource(protectedSource, fetcher);
    expect(receivedRange).toBe("bytes=0-4095");
    expect(result.kind).toBe("hls");
  });
});
