// ─────────────────────────────────────────────────────────────────────────────
// data_source.js — capa de datos abstracta (ReWind).
//
// Hoy: «SimulatedSource» sobre un Web Worker (shm_worker.js) que entrega telemetría
// sintética. Mañana: «LiveSource» que consuma la nube (gateway → Worker Cloudflare →
// WebSocket) emitiendo el MISMO `onTick`. El dashboard no sabe cuál usa.
// ─────────────────────────────────────────────────────────────────────────────
export class DataSource {
  constructor() {
    this.worker = new Worker(new URL('./shm_worker.js?v=199', import.meta.url));
    this.latest = {};            // summaries por id (último tick)
    this.onTick = null;          // callback({t, summaries, waves})
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'tick') { this.latest = m.summaries; this.onTick?.(m); }
    };
  }
  /** structs: [{id, type, f1, dmg, sensors:[{id,status}]}] */
  init(structs) { this.worker.postMessage({ type: 'init', structs }); }
  /** Estructura enfocada → el worker manda su señal temporal en detalle. */
  focus(id) { this.worker.postMessage({ type: 'focus', id }); }
  get(id) { return this.latest[id] || null; }
}
