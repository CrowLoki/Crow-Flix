import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import Hls from "hls.js";
import type { MediaPlayerClass } from "dashjs";
import { createTauriHlsLoader } from "./TauriHlsLoader";
import { installNativeDashTransport } from "./dashTransport";
import {
  classifySource,
  orderPlaybackSources,
  sanitizeStreamUrl,
  shouldFallback,
} from "./logic";
import { probeSource } from "./nativeFetch";
import {
  type PlaybackDiagnostic,
  type PlaybackFailureReason,
  type PlaybackKind,
  type PlaybackStatus,
  type SourceHealth,
  type StreamSource,
  sourceIdentifier,
} from "./types";
import { ProgressWatchdog } from "./stallWatchdog";

const STARTUP_TIMEOUT_MS = 20_000;
const STALL_TIMEOUT_MS = 18_000;
const HEALTH_STORAGE_KEY = "crowflix:source-health:v1";
const PREFERRED_STORAGE_KEY = "crowflix:preferred-source:v1";

function isManifestNetworkFailure(details: unknown): boolean {
  return details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
    || details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
    || details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
}

export type PlaybackChannel = {
  key: string;
  name: string;
  sources: StreamSource[];
};

export type PlaybackControllerState = {
  status: PlaybackStatus;
  message: string;
  source: StreamSource | null;
  sourceNumber: number;
  sourceTotal: number;
  canNext: boolean;
  diagnostics: PlaybackDiagnostic[];
};

export type PlaybackController = PlaybackControllerState & {
  retry: () => void;
  next: () => void;
  resume: () => void;
};

const IDLE_STATE: PlaybackControllerState = {
  status: "idle",
  message: "",
  source: null,
  sourceNumber: 0,
  sourceTotal: 0,
  canNext: false,
  diagnostics: [],
};

export function usePlaybackController(
  channel: PlaybackChannel | null,
  videoRef: RefObject<HTMLVideoElement | null>,
): PlaybackController {
  const [state, setState] = useState<PlaybackControllerState>(IDLE_STATE);
  const runRef = useRef<PlaybackRun | null>(null);

  useEffect(() => {
    runRef.current?.dispose();
    runRef.current = null;
    const video = videoRef.current;
    if (!channel || !video) {
      setState(IDLE_STATE);
      return;
    }
    const run = new PlaybackRun(channel, video, setState);
    runRef.current = run;
    run.start();
    return () => {
      run.dispose();
      if (runRef.current === run) runRef.current = null;
    };
  }, [channel, videoRef]);

  return {
    ...state,
    retry: useCallback(() => runRef.current?.retry(), []),
    next: useCallback(() => runRef.current?.next(), []),
    resume: useCallback(() => runRef.current?.resume(), []),
  };
}

export class PlaybackRun {
  private orderedSources: StreamSource[] = [];
  private health: Record<string, SourceHealth> = {};
  private cursor = 0;
  private generation = 0;
  private disposed = false;
  private attemptCleanup: (() => void) | null = null;
  private diagnostics: PlaybackDiagnostic[] = [];

  constructor(
    private readonly channel: PlaybackChannel,
    private readonly video: HTMLVideoElement,
    private readonly update: (state: PlaybackControllerState) => void,
  ) {
    this.health = readRecord<SourceHealth>(HEALTH_STORAGE_KEY);
    this.refreshSourceOrder();
  }

  start(): void {
    if (!this.orderedSources.length) {
      this.update({
        ...IDLE_STATE,
        status: "failed",
        message: "This preview card has no live source. Open CrowFlix on the desktop to load the live catalogue.",
      });
      return;
    }
    this.startAttempt(0, "loading");
  }

  retry(): void {
    if (this.disposed) return;
    this.health = readRecord<SourceHealth>(HEALTH_STORAGE_KEY);
    this.refreshSourceOrder();
    if (!this.orderedSources.length) return;
    this.startAttempt(0, "loading");
  }

  next(): void {
    if (this.disposed || this.cursor + 1 >= this.orderedSources.length) return;
    this.startAttempt(this.cursor + 1, "switching");
  }

  resume(): void {
    if (this.disposed) return;
    void this.video.play().then(() => {
      if (this.disposed) return;
      this.publish("playing", "Playing live");
    }).catch(() => {
      if (this.disposed) return;
      this.publish("interaction-required", "Press play to start this channel.");
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.attemptCleanup?.();
    this.attemptCleanup = null;
  }

  private startAttempt(index: number, status: "loading" | "switching"): void {
    if (this.disposed) return;
    this.generation += 1;
    this.attemptCleanup?.();
    this.attemptCleanup = null;
    this.cursor = index;
    const token = this.generation;
    const source = this.orderedSources[index];
    this.publish(
      status,
      status === "switching"
        ? `Trying source ${index + 1} of ${this.orderedSources.length}…`
        : `Connecting to source ${index + 1} of ${this.orderedSources.length}…`,
    );
    void this.prepareAndPlay(source, token);
  }

  private async prepareAndPlay(source: StreamSource, token: number): Promise<void> {
    let selected = source;
    let kind = classifySource(selected);
    const probeController = new AbortController();
    this.attemptCleanup = () => {
      probeController.abort();
      this.resetVideo();
    };

    if (kind === "unknown") {
      try {
        const probed = await probeSource(selected, undefined, probeController.signal);
        if (!this.isActive(token)) return;
        selected = { ...selected, url: probed.url };
        kind = probed.kind === "unknown" ? "progressive" : probed.kind;
      } catch {
        this.fail(token, selected, kind, "network", "The source did not answer its format check.");
        return;
      }
    }
    if (!this.isActive(token)) return;
    if (kind === "unsupported") {
      this.fail(
        token,
        selected,
        kind,
        "unsupported",
        "This source uses a streaming protocol that CrowFlix cannot play.",
      );
      return;
    }
    this.installPlayer(selected, kind, token);
  }

  private installPlayer(source: StreamSource, kind: PlaybackKind, token: number): void {
    const cleanupTasks: Array<() => void> = [];
    let cleaned = false;
    this.attemptCleanup = () => {
      if (cleaned) return;
      cleaned = true;
      cleanupTasks.reverse().forEach((cleanup) => {
        try { cleanup(); } catch { /* best-effort library cleanup */ }
      });
      this.resetVideo();
    };
    const startupTimer = setTimeout(
      () => this.fail(
        token,
        source,
        kind,
        "startup-timeout",
        "This source did not begin playing in time.",
      ),
      STARTUP_TIMEOUT_MS,
    );
    cleanupTasks.push(() => clearTimeout(startupTimer));

    let hasPlayed = false;
    let deliberatelyPaused = false;
    let lastTime = -1;
    let mediaRecoveryUsed = false;
    let networkRecoveryUsed = false;
    let hls: Hls | null = null;
    let dashPlayer: MediaPlayerClass | null = null;

    const stallWatchdog = new ProgressWatchdog(
      STALL_TIMEOUT_MS,
      () => this.fail(
        token,
        source,
        kind,
        "stall-timeout",
        "Playback stopped receiving media.",
      ),
    );
    const attemptPlay = () => {
      if (!this.isActive(token)) return;
      void this.video.play().catch((error: unknown) => {
        if (!this.isActive(token)) return;
        const errorName = error && typeof error === "object" && "name" in error
          ? String(error.name)
          : "";
        if (errorName === "NotAllowedError") {
          clearTimeout(startupTimer);
          this.publish("interaction-required", "Press play to start this channel.");
        }
      });
    };
    const onPlaying = () => {
      if (!this.isActive(token)) return;
      if (!hasPlayed || deliberatelyPaused) stallWatchdog.start();
      else stallWatchdog.ensure();
      hasPlayed = true;
      deliberatelyPaused = false;
      clearTimeout(startupTimer);
      recordSourceSuccess(this.channel.key, source, this.health);
      this.publish("playing", "Playing live");
    };
    const onTimeUpdate = () => {
      if (!this.isActive(token)) return;
      if (Math.abs(this.video.currentTime - lastTime) > 0.2) {
        lastTime = this.video.currentTime;
        stallWatchdog.progress();
      }
    };
    const onPause = () => {
      if (!this.isActive(token) || this.video.ended) return;
      deliberatelyPaused = true;
      stallWatchdog.stop();
    };
    const onMediaError = () => {
      if (!this.isActive(token)) return;
      if (kind === "hls" && hls && !mediaRecoveryUsed) {
        mediaRecoveryUsed = true;
        this.publish("loading", "Recovering this source…");
        hls.recoverMediaError();
        return;
      }
      this.fail(token, source, kind, "media", "The source returned media the player could not decode.");
    };
    const addVideoListener = <K extends keyof HTMLMediaElementEventMap>(
      event: K,
      listener: (event: HTMLMediaElementEventMap[K]) => void,
    ) => {
      this.video.addEventListener(event, listener);
      cleanupTasks.push(() => this.video.removeEventListener(event, listener));
    };
    addVideoListener("playing", onPlaying);
    addVideoListener("timeupdate", onTimeUpdate);
    addVideoListener("waiting", () => stallWatchdog.ensure());
    addVideoListener("stalled", () => stallWatchdog.ensure());
    addVideoListener("pause", onPause);
    addVideoListener("canplay", attemptPlay);
    addVideoListener("error", onMediaError);
    addVideoListener("ended", onMediaError);
    cleanupTasks.push(() => stallWatchdog.stop());

    if (kind === "hls" && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        loader: createTauriHlsLoader(source),
      });
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (this.isActive(token)) hls?.loadSource(source.url);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, attemptPlay);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!this.isActive(token) || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !networkRecoveryUsed) {
          networkRecoveryUsed = true;
          this.publish("loading", "Retrying this source…");
          if (isManifestNetworkFailure(data.details)) {
            hls?.loadSource(source.url);
          } else {
            hls?.startLoad();
          }
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryUsed) {
          mediaRecoveryUsed = true;
          this.publish("loading", "Recovering this source…");
          hls?.recoverMediaError();
          return;
        }
        this.fail(
          token,
          source,
          kind,
          data.type === Hls.ErrorTypes.NETWORK_ERROR ? "network" : "media",
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? "The source stopped responding."
            : "The source returned media the player could not decode.",
        );
      });
      hls.attachMedia(this.video);
      cleanupTasks.push(() => {
        hls?.stopLoad();
        hls?.detachMedia();
        hls?.destroy();
        hls = null;
      });
    } else if (kind === "hls") {
      if (sourceNeedsHeaders(source) || !this.video.canPlayType("application/vnd.apple.mpegurl")) {
        this.fail(
          token,
          source,
          kind,
          "unsupported",
          "This HLS source needs playback support that is unavailable on this device.",
        );
        return;
      }
      this.video.src = source.url;
      this.video.load();
    } else if (kind === "dash") {
      void import("dashjs").then((dashModule) => {
        if (!this.isActive(token)) return;
        try {
          dashPlayer = dashModule.MediaPlayer().create();
          installNativeDashTransport(dashPlayer, source);
          dashPlayer.setConfig({
            streaming: {
              lowLatencyEnabled: false,
              retryAttempts: { MPD: 2, MediaSegment: 2, InitializationSegment: 2 },
            },
          });
          const onDashError = () => {
            this.fail(token, source, kind, "network", "The DASH source could not be loaded.");
          };
          dashPlayer.on(dashModule.MediaPlayer.events.ERROR, onDashError);
          cleanupTasks.push(() => dashPlayer?.off(dashModule.MediaPlayer.events.ERROR, onDashError));
          cleanupTasks.push(() => {
            dashPlayer?.destroy();
            dashPlayer = null;
          });
          dashPlayer.initialize(this.video, source.url, false);
        } catch {
          this.fail(token, source, kind, "unsupported", "DASH playback could not be initialized.");
        }
      }).catch(() => {
        this.fail(token, source, kind, "unsupported", "DASH playback could not be loaded.");
      });
    } else {
      if (sourceNeedsHeaders(source)) {
        this.fail(
          token,
          source,
          kind,
          "unsupported",
          "This direct media source requires request headers that the video element cannot attach.",
        );
        return;
      }
      this.video.src = source.url;
      this.video.load();
    }

  }

  private fail(
    token: number,
    source: StreamSource,
    kind: PlaybackKind,
    reason: PlaybackFailureReason,
    message: string,
  ): void {
    if (!this.isActive(token)) return;
    this.generation += 1;
    this.diagnostics = [
      ...this.diagnostics,
      {
        sourceId: sourceIdentifier(source, this.cursor),
        sourceNumber: this.cursor + 1,
        transport: kind,
        endpoint: sanitizeStreamUrl(source.url),
        reason,
        at: new Date().toISOString(),
      },
    ].slice(-8);
    if (reason !== "aborted" && reason !== "autoplay") {
      recordSourceFailure(source, this.health);
    }
    this.attemptCleanup?.();
    this.attemptCleanup = null;

    if (shouldFallback(reason) && this.cursor + 1 < this.orderedSources.length) {
      this.publish("switching", `${message} Trying the next source…`);
      queueMicrotask(() => this.startAttempt(this.cursor + 1, "switching"));
      return;
    }
    this.publish("failed", message);
  }

  private publish(status: PlaybackStatus, message: string): void {
    const source = this.orderedSources[this.cursor] || null;
    this.update({
      status,
      message,
      source,
      sourceNumber: source ? this.cursor + 1 : 0,
      sourceTotal: this.orderedSources.length,
      canNext: this.cursor + 1 < this.orderedSources.length,
      diagnostics: this.diagnostics,
    });
  }

  private isActive(token: number): boolean {
    return !this.disposed && token === this.generation;
  }

  private refreshSourceOrder(): void {
    const preferred = readRecord<string>(PREFERRED_STORAGE_KEY)[this.channel.key];
    this.orderedSources = orderPlaybackSources(
      this.channel.sources,
      this.health,
      preferred,
    );
  }

  private resetVideo(): void {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}

function sourceNeedsHeaders(source: StreamSource): boolean {
  return Boolean(source.requiresHeaders || source.referrer || source.userAgent);
}

function readRecord<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as Record<string, T> : {};
  } catch {
    return {};
  }
}

function writeRecord<T>(key: string, value: Record<string, T>): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ }
}

function recordSourceFailure(
  source: StreamSource,
  health: Record<string, SourceHealth>,
): void {
  const id = sourceIdentifier(source);
  const failures = Math.min((health[id]?.failures || 0) + 1, 8);
  health[id] = {
    ...health[id],
    failures,
    cooldownUntil: Date.now() + Math.min(30 * 60_000, 30_000 * (2 ** (failures - 1))),
  };
  writeRecord(HEALTH_STORAGE_KEY, health);
}

function recordSourceSuccess(
  channelKey: string,
  source: StreamSource,
  health: Record<string, SourceHealth>,
): void {
  const id = sourceIdentifier(source);
  health[id] = { failures: 0, cooldownUntil: 0, lastSuccessAt: Date.now() };
  writeRecord(HEALTH_STORAGE_KEY, health);
  const preferred = readRecord<string>(PREFERRED_STORAGE_KEY);
  preferred[channelKey] = id;
  writeRecord(PREFERRED_STORAGE_KEY, preferred);
}
