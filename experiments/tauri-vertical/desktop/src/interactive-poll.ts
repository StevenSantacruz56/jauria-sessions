/** One awaited poll loop; input can wake its idle timer, never start another poll. */
export class InteractivePoll {
  private activeUntil = 0;
  private wake?: () => void;
  private now: () => number;
  constructor(now = () => performance.now()) { this.now = now; }
  activity() {
    this.activeUntil = this.now() + 1200;
    this.wake?.();
  }
  delay(foreground: boolean) {
    return foreground && this.now() < this.activeUntil ? 12 : 150;
  }
  wait(foreground: boolean): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        if (this.wake === finish) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, this.delay(foreground));
      // Background input must not turn occluded windows into a fast poll loop.
      if (foreground) this.wake = finish;
    });
  }
}
