import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressWatchdog } from "./stallWatchdog";

describe("ProgressWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays armed and times out from the last genuine progress", () => {
    const timedOut = vi.fn();
    const watchdog = new ProgressWatchdog(18_000, timedOut);
    watchdog.start();

    vi.advanceTimersByTime(12_000);
    watchdog.progress();
    vi.advanceTimersByTime(17_999);
    expect(timedOut).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(timedOut).toHaveBeenCalledOnce();
  });

  it("does not treat waiting notifications as playback progress", () => {
    const timedOut = vi.fn();
    const watchdog = new ProgressWatchdog(18_000, timedOut);
    watchdog.start();

    vi.advanceTimersByTime(10_000);
    watchdog.ensure();
    vi.advanceTimersByTime(8_000);

    expect(timedOut).toHaveBeenCalledOnce();
  });

  it("stops cleanly for deliberate pauses", () => {
    const timedOut = vi.fn();
    const watchdog = new ProgressWatchdog(18_000, timedOut);
    watchdog.start();
    vi.advanceTimersByTime(5_000);
    watchdog.stop();
    vi.advanceTimersByTime(30_000);
    expect(timedOut).not.toHaveBeenCalled();
  });
});
