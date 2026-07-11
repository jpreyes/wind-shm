// ─────────────────────────────────────────────────────────────────────────────
// replay.js — Frente 2 · R-37 · reproducción del histórico (time-scrubber).
//
// `ReplaySource` emite ticks con la MISMA forma que DataSource
// ({type:'tick', t, summaries, waves}) pero reconstruidos desde el histórico
// (IndexedDB, R-34) y a velocidad acelerada. Así el dashboard «no nota la
// diferencia»: se le puede pasar el mismo `handleTick`. Valida la arquitectura
// para el backend en vivo (R-10).
// ─────────────────────────────────────────────────────────────────────────────
import * as Hist from './history.js?v=320';

export class ReplaySource {
  /** @param {{onTick, onProgress?, onEnd?, sensorsFor?}} o */
  constructor(o = {}) {
    this.onTick = o.onTick || (() => {});
    this.onProgress = o.onProgress || (() => {});
    this.onEnd = o.onEnd || (() => {});
    this.sensorsFor = o.sensorsFor || (() => []);
    this._timer = null; this._series = {}; this._ids = [];
    this.from = 0; this.to = 0; this.t = 0; this.speed = 60;
  }

  // Carga el histórico de las estructuras en el rango [fromTs, toTs].
  async load(ids, fromTs, toTs) {
    this._ids = ids; this._series = {};
    let min = Infinity, max = -Infinity, n = 0;
    for (const id of ids) {
      const r = await Hist.range(id, fromTs);
      const inRange = r.filter(s => s.t <= toTs);
      this._series[id] = inRange;
      for (const s of inRange) { if (s.t < min) min = s.t; if (s.t > max) max = s.t; n++; }
    }
    this.from = isFinite(min) ? min : fromTs;
    this.to = isFinite(max) ? max : toTs;
    this.t = this.from;
    return { from: this.from, to: this.to, samples: n };
  }

  // Muestra ≤ t (búsqueda binaria; series ascendentes por tiempo).
  _nearest(arr, t) {
    let lo = 0, hi = arr.length - 1, res = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { res = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
    return res || arr[0] || null;
  }

  _emit() {
    const summaries = {};
    for (const id of this._ids) {
      const s = this._nearest(this._series[id], this.t);
      if (!s) continue;
      summaries[id] = {
        f1: s.f1, rms: s.rms, wind: s.wind, tilt: s.tilt, dmg: 0, cls: 0, standby: false,
        sensors: this.sensorsFor(id).map(se => ({ id: se.id, status: 'ok', rms: s.rms })),
      };
    }
    this.onTick({ type: 'tick', t: this.t, summaries, waves: {} });
    this.onProgress(this.t);
  }

  seek(ts) { this.t = Math.max(this.from, Math.min(this.to, ts)); this._emit(); }

  play(speed = this.speed) {
    this.stop(); this.speed = speed;
    if (this.t >= this.to) this.t = this.from;   // rebobinar si estaba al final
    this._last = performance.now();
    this._timer = setInterval(() => {
      const now = performance.now(), dt = (now - this._last) / 1000; this._last = now;
      this.t += dt * 1000 * this.speed;
      if (this.t >= this.to) { this.t = this.to; this._emit(); this.stop(); this.onEnd(); return; }
      this._emit();
    }, 100);
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
  playing() { return !!this._timer; }
}
