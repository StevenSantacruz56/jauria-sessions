import type { Attention } from './attention';
type Api = { granted(): Promise<boolean>; request(): Promise<string>; send(): void };
/** No permission checks or prompts until the user clicks Enable. No delivery receipt. */
export class NativeAttention {
  enabled = false;
  private delivered = new Set<string>();
  private pending = new Set<string>();
  private latest: Attention[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private epoch = 0;
  private api: Api;
  private eligible: (id: string) => boolean;
  private feedback: (text: string) => void;
  private delay: number;
  constructor(api: Api, eligible: (id: string) => boolean, feedback: (text: string) => void, delay = 1500) { this.api = api; this.eligible = eligible; this.feedback = feedback; this.delay = delay; }
  async enableFromClick(items: Attention[]) {
    const epoch = ++this.epoch;
    try {
      const granted = await this.api.granted() || await this.api.request() === 'granted';
      if (epoch !== this.epoch) return;
      this.enabled = granted;
      this.delivered = new Set(items.flatMap(item => item.keys));
      this.feedback(granted ? 'Activadas en esta apertura. Entrega sujeta a macOS; el permiso informado por el plugin no confirma la configuración del sistema.' : 'Permiso no concedido. Los avisos dentro de Jauría siguen disponibles.');
    } catch {
      if (epoch !== this.epoch) return;
      this.enabled = false; this.feedback('No se pudo activar la notificación nativa. Los avisos dentro de Jauría siguen disponibles.');
    }
  }
  update(items: Attention[]) {
    this.latest = items;
    if (!this.enabled) return;
    const active = new Set(items.flatMap(item => item.keys));
    for (const key of this.delivered) if (!active.has(key)) this.delivered.delete(key);
    for (const item of items) if (item.unseen && !item.stale && this.eligible(item.id) && item.keys.some(key => !this.delivered.has(key))) this.pending.add(item.id);
    if (!this.pending.size || this.timer) return;
    const epoch = this.epoch;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(epoch); }, this.delay);
  }
  private async flush(epoch: number) {
    const pending = this.pending; this.pending = new Set();
    try {
      if (!this.enabled || epoch !== this.epoch) return;
      if (!await this.api.granted()) { this.disable(); this.feedback('Permiso nativo no disponible. Los avisos dentro de Jauría siguen disponibles.'); return; }
      if (!this.enabled || epoch !== this.epoch) return;
      // One generic notice per batch, no titles, paths, terminal output or permissions.
      const items = this.latest.filter(item => pending.has(item.id) && item.unseen && !item.stale && this.eligible(item.id) && item.keys.some(key => !this.delivered.has(key)));
      if (!items.length) return;
      this.api.send();
      for (const item of items) for (const key of item.keys) this.delivered.add(key);
    } catch { if (epoch === this.epoch) { this.disable(); this.feedback('No se pudo solicitar el aviso nativo. Los avisos dentro de Jauría siguen disponibles.'); } }
  }
  disable() { this.enabled = false; this.epoch++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending.clear(); }
}
