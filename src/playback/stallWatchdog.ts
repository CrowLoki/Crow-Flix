export class ProgressWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  private active = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.active = true;
    this.lastProgressAt = this.now();
    this.schedule(this.timeoutMs);
  }

  progress(): void {
    if (!this.active) return;
    this.lastProgressAt = this.now();
    this.schedule(this.timeoutMs);
  }

  ensure(): void {
    if (!this.active || this.timer) return;
    this.schedule(Math.max(0, this.timeoutMs - (this.now() - this.lastProgressAt)));
  }

  stop(): void {
    this.active = false;
    this.clear();
  }

  private check(): void {
    this.timer = null;
    if (!this.active) return;
    const remaining = this.timeoutMs - (this.now() - this.lastProgressAt);
    if (remaining > 0) {
      this.schedule(remaining);
      return;
    }
    this.active = false;
    this.onTimeout();
  }

  private schedule(delay: number): void {
    this.clear();
    this.timer = setTimeout(() => this.check(), delay);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
