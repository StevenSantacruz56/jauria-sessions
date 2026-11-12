import type { Attention } from './attention';

/** One generic number per confirmed unread session, never per request or reason. */
export function dockUnreadCount(items: readonly Attention[]): number {
  return new Set(items.filter(item => item.unseen && !item.stale).map(item => item.id)).size;
}

/** Latest count wins; at most one native write is in flight. No polling or prompts. */
export class DockBadge {
  private desired: number | undefined;
  private applied: number | undefined;
  private revision = 0;
  private processed = 0;
  private running: Promise<void> | undefined;
  private disposed = false;
  private readonly write: (count?: number) => Promise<void>;

  constructor(write: (count?: number) => Promise<void>) { this.write = write; }

  setCount(count: number): void {
    if (this.disposed) return;
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid badge count');
    if (count === this.desired) return;
    this.desired = count;
    this.revision++;
    this.start();
  }

  /** Best effort on webview unload; a new controller also clears on startup. */
  dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.desired = 0;
      this.applied = undefined;
      this.revision++;
      this.start();
    }
    return this.running ?? Promise.resolve();
  }

  private start(): void {
    if (!this.running) this.running = this.flush().finally(() => {
      this.running = undefined;
      if (this.processed !== this.revision) this.start();
    });
  }

  private async flush(): Promise<void> {
    let revision: number;
    do {
      revision = this.revision;
      const count = this.desired!;
      if (count !== this.applied) {
        try {
          // undefined removes the native badge (including on macOS).
          await this.write(count || undefined);
          this.applied = count;
        } catch {
          // Do not retry every refresh on an unavailable/denied native API.
          // A different count or disposal makes a fresh attempt.
          this.applied = undefined;
        }
      }
      this.processed = revision;
    } while (revision !== this.revision);
  }
}
