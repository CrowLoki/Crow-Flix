import { describe, expect, it } from "vitest";
import worker from "../src/index";

const call = (path: string, method = "GET"): Promise<Response> =>
  worker.fetch(new Request(`https://relay.example${path}`, { method }));

describe("worker routing", () => {
  it("GET /health returns the service identity with CORS *", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({
      ok: true,
      service: "crowflix-relay",
      version: "0.1.0",
    });
  });

  it("answers CORS preflight", async () => {
    const response = await call("/stream", "OPTIONS");
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "GET",
    );
  });

  it("rejects non-GET methods with 405 JSON", async () => {
    const response = await call("/health", "POST");
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "Only GET requests are supported.",
    });
  });

  it("returns 404 JSON for unknown routes, with CORS", async () => {
    const response = await call("/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({ error: "Unknown relay route." });
  });
});

describe("worker input validation (no network is touched)", () => {
  it("/fetch without url is a 400", async () => {
    const response = await call("/fetch");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/url parameter/);
  });

  it("/fetch rejects private addresses with a 400 and CORS", async () => {
    const response = await call(
      `/fetch?url=${encodeURIComponent("http://127.0.0.1/")}`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await response.json()).error).toMatch(/local or private/);
  });

  it("/fetch rejects embedded credentials", async () => {
    const response = await call(
      `/fetch?url=${encodeURIComponent("https://user:pass@example.com/")}`,
    );
    expect(response.status).toBe(400);
  });

  it("/fetch rejects non-http schemes", async () => {
    const response = await call(
      `/fetch?url=${encodeURIComponent("ftp://example.com/x")}`,
    );
    expect(response.status).toBe(400);
  });

  it("/stream validates the target before any upstream fetch", async () => {
    const response = await call(
      `/stream?url=${encodeURIComponent("http://192.168.0.1/")}`,
    );
    expect(response.status).toBe(400);
  });

  it("/stream rejects control characters in the ua parameter", async () => {
    const response = await call(
      `/stream?url=${encodeURIComponent("https://example.com/x.m3u8")}&ua=bad%0Avalue`,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/ua parameter/);
  });

  it("/epg without ids is a 400", async () => {
    const response = await call("/epg?country=AU");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/at least one channel id/);
  });
});
