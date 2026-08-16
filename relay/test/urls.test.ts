import { describe, expect, it } from "vitest";
import { RelayError } from "../src/errors";
import { fetchValidated, validateExternalUrl } from "../src/urls";
import type { FetchLike } from "../src/urls";

describe("validateExternalUrl accepts", () => {
  it.each([
    "https://example.com/playlist.m3u",
    "http://cdn.example.com:8080/x?q=1&y=2",
    "https://172.15.0.1/public-edge-of-172-block",
    "https://8.8.8.8/dns",
    "https://example.com./trailing-dot",
  ])("accepts %s", (raw) => {
    const url = validateExternalUrl(raw);
    expect(url.protocol.startsWith("http")).toBe(true);
  });
});

describe("validateExternalUrl rejects", () => {
  it.each([
    ["empty string", ""],
    ["leading whitespace", " https://example.com/"],
    ["trailing whitespace", "https://example.com/ "],
    ["ftp scheme", "ftp://example.com/x"],
    ["file scheme", "file:///etc/passwd"],
    ["javascript scheme", "javascript:alert(1)"],
    ["embedded credentials", "https://user:pass@example.com/"],
    ["embedded username", "https://user@example.com/"],
    ["localhost", "http://localhost/"],
    ["localhost with port", "http://localhost:8080/"],
    ["subdomain of localhost", "http://foo.localhost/"],
    ["trailing-dot localhost", "http://localhost./"],
    ["loopback 127.0.0.1", "http://127.0.0.1/"],
    ["loopback shorthand 127.1", "http://127.1/"],
    ["decimal loopback", "http://2130706433/"],
    ["hex loopback", "http://0x7f000001/"],
    ["private 10/8", "http://10.0.0.5/"],
    ["private 172.16/12 low", "http://172.16.0.1/"],
    ["private 172.16/12 high", "http://172.31.255.255/"],
    ["private 192.168/16", "http://192.168.1.1/"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data"],
    ["CGNAT 100.64/10", "http://100.64.0.1/"],
    ["unspecified 0.0.0.0", "http://0.0.0.0/"],
    ["multicast 224+", "http://239.0.0.1/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv6 unspecified", "http://[::]/"],
    ["IPv6 link-local", "http://[fe80::1]/"],
    ["IPv6 unique-local", "http://[fd12:3456::1]/"],
    ["IPv6 mapped loopback", "http://[::ffff:127.0.0.1]/"],
    ["IPv6 mapped private", "http://[::ffff:192.168.0.1]/"],
  ])("rejects %s", (_label, raw) => {
    expect(() => validateExternalUrl(raw)).toThrowError(RelayError);
  });

  it("rejects URLs over the length limit", () => {
    const raw = `https://example.com/${"x".repeat(8_192)}`;
    expect(() => validateExternalUrl(raw)).toThrowError(RelayError);
  });

  it("rejects URLs containing control characters", () => {
    const raw = `http://exa${String.fromCharCode(10)}mple.com/`;
    expect(() => validateExternalUrl(raw)).toThrowError(RelayError);
  });

  it("uses a 400 status for rejected user input", () => {
    try {
      validateExternalUrl("http://127.0.0.1/");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RelayError);
      expect((error as RelayError).status).toBe(400);
    }
  });
});

describe("fetchValidated redirect handling", () => {
  const responder =
    (routes: Record<string, () => Response>) =>
    async (input: URL | string, init?: RequestInit): Promise<Response> => {
      const href = typeof input === "string" ? input : input.href;
      const handler = routes[href];
      if (!handler) return new Response("not found", { status: 404 });
      expect(init?.redirect).toBe("manual");
      return handler();
    };

  it("follows a redirect to another public URL", async () => {
    const fetcher = responder({
      "https://cdn.example/start": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/final" },
        }),
      "https://cdn.example/final": () => new Response("done", { status: 200 }),
    });
    const response = await fetchValidated(
      new URL("https://cdn.example/start"),
      {},
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("done");
  });

  it("resolves relative redirect targets", async () => {
    const fetcher = responder({
      "https://cdn.example/start": () =>
        new Response(null, { status: 301, headers: { location: "/moved" } }),
      "https://cdn.example/moved": () => new Response("ok", { status: 200 }),
    });
    const response = await fetchValidated(
      new URL("https://cdn.example/start"),
      {},
      fetcher,
    );
    expect(response.status).toBe(200);
  });

  it("blocks a redirect to a private address", async () => {
    const calls: string[] = [];
    const fetcher: FetchLike = async (input, init) => {
      const href = typeof input === "string" ? input : input.href;
      calls.push(href);
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    };
    await expect(
      fetchValidated(new URL("https://cdn.example/start"), {}, fetcher),
    ).rejects.toThrowError(/private/i);
    expect(calls).toEqual(["https://cdn.example/start"]);
  });

  it("gives up after too many redirects", async () => {
    const fetcher = responder({
      "https://cdn.example/loop": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/loop" },
        }),
    });
    await expect(
      fetchValidated(new URL("https://cdn.example/loop"), {}, fetcher),
    ).rejects.toThrowError(/too many redirects/i);
  });
});
