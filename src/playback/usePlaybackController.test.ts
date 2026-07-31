import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockHlsError = {
  fatal: boolean;
  type: string;
  details: string;
};

type MockHlsHandler = (event: string, data?: MockHlsError) => void;

type MockHlsInstance = {
  handlers: Map<string, MockHlsHandler>;
  loadSource: ReturnType<typeof vi.fn>;
  startLoad: ReturnType<typeof vi.fn>;
};

const hlsState = vi.hoisted(() => ({
  instances: [] as MockHlsInstance[],
}));

vi.mock("hls.js", () => {
  class MockHls {
    static isSupported = () => true;
    static Events = {
      MEDIA_ATTACHED: "hlsMediaAttached",
      MANIFEST_PARSED: "hlsManifestParsed",
      ERROR: "hlsError",
    };
    static ErrorTypes = {
      NETWORK_ERROR: "networkError",
      MEDIA_ERROR: "mediaError",
    };
    static ErrorDetails = {
      MANIFEST_LOAD_ERROR: "manifestLoadError",
      MANIFEST_LOAD_TIMEOUT: "manifestLoadTimeOut",
      MANIFEST_PARSING_ERROR: "manifestParsingError",
      FRAG_LOAD_ERROR: "fragLoadError",
    };

    handlers = new Map<string, MockHlsHandler>();
    startLoad = vi.fn();
    loadSource = vi.fn();
    recoverMediaError = vi.fn();
    attachMedia = vi.fn();
    stopLoad = vi.fn();
    detachMedia = vi.fn();
    destroy = vi.fn();

    constructor() {
      hlsState.instances.push(this);
    }

    on(event: string, handler: MockHlsHandler): void {
      this.handlers.set(event, handler);
    }
  }

  return { default: MockHls };
});

import {
  PlaybackRun,
  type PlaybackControllerState,
} from "./usePlaybackController";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("PlaybackRun retry", () => {
  beforeEach(() => {
    hlsState.instances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    hlsState.instances.length = 0;
  });

  it("rebuilds ordering and restarts at the fresh source zero after exhaustion", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const updates: PlaybackControllerState[] = [];
    const video = {
      ended: false,
      load: vi.fn(),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun(
      {
        key: "retry-channel",
        name: "Retry Channel",
        sources: [
          { id: "first", url: "rtmp://provider.test/first" },
          { id: "final", url: "rtmp://provider.test/final" },
        ],
      },
      video,
      (state) => updates.push(state),
    );

    run.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(updates[updates.length - 1]?.status).toBe("failed");
    expect(updates[updates.length - 1]?.source?.id).toBe("final");

    storage.setItem("crowflix:source-health:v1", JSON.stringify({
      first: { failures: 0, cooldownUntil: 0 },
      final: { failures: 2, cooldownUntil: Date.now() + 60_000 },
    }));
    updates.length = 0;
    run.retry();

    expect(updates[0]?.status).toBe("loading");
    expect(updates[0]?.sourceNumber).toBe(1);
    expect(updates[0]?.source?.id).toBe("first");
    run.dispose();
  });

  it("reloads the manifest once after a fatal manifest network error before failing over", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const updates: PlaybackControllerState[] = [];
    const video = {
      currentTime: 0,
      ended: false,
      addEventListener: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      removeAttribute: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun(
      {
        key: "hls-recovery-channel",
        name: "HLS Recovery Channel",
        sources: [
          { id: "primary", url: "https://provider.test/primary.m3u8" },
          { id: "backup", url: "https://provider.test/backup.m3u8" },
        ],
      },
      video,
      (state) => updates.push(state),
    );

    run.start();
    const primary = hlsState.instances[0];
    primary?.handlers.get("hlsMediaAttached")?.("hlsMediaAttached");
    const onError = primary?.handlers.get("hlsError");
    expect(onError).toBeDefined();
    expect(primary.loadSource).toHaveBeenCalledOnce();

    onError?.("hlsError", {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });

    expect(primary.loadSource).toHaveBeenCalledTimes(2);
    expect(primary.loadSource).toHaveBeenLastCalledWith(
      "https://provider.test/primary.m3u8",
    );
    expect(primary.startLoad).not.toHaveBeenCalled();
    expect(updates[updates.length - 1]).toMatchObject({
      status: "loading",
      message: "Retrying this source…",
      source: { id: "primary" },
    });
    expect(storage.getItem("crowflix:source-health:v1")).toBeNull();
    expect(hlsState.instances).toHaveLength(1);

    onError?.("hlsError", {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(primary.loadSource).toHaveBeenCalledTimes(2);
    expect(primary.startLoad).not.toHaveBeenCalled();
    expect(hlsState.instances).toHaveLength(2);
    expect(updates[updates.length - 1]).toMatchObject({
      status: "switching",
      source: { id: "backup" },
    });
    expect(JSON.parse(storage.getItem("crowflix:source-health:v1") || "{}"))
      .toMatchObject({ primary: { failures: 1 } });
    run.dispose();
  });

  it("uses startLoad for a first fatal post-manifest network error", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const video = {
      currentTime: 0,
      ended: false,
      addEventListener: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      removeAttribute: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    const run = new PlaybackRun(
      {
        key: "hls-fragment-recovery-channel",
        name: "HLS Fragment Recovery Channel",
        sources: [
          { id: "primary", url: "https://provider.test/primary.m3u8" },
        ],
      },
      video,
      vi.fn(),
    );

    run.start();
    const primary = hlsState.instances[0];
    primary?.handlers.get("hlsMediaAttached")?.("hlsMediaAttached");
    const onError = primary?.handlers.get("hlsError");

    onError?.("hlsError", {
      fatal: true,
      type: "networkError",
      details: "fragLoadError",
    });

    expect(primary.loadSource).toHaveBeenCalledOnce();
    expect(primary.startLoad).toHaveBeenCalledOnce();
    expect(storage.getItem("crowflix:source-health:v1")).toBeNull();
    run.dispose();
  });
});
