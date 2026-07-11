// ─────────────────────────────────────────────────────────────────────────────
// data_source.js — capa de datos abstracta (ReWind).
//
// Dos fuentes con el MISMO `onTick`/`init`/`focus`/`get`:
//   · SimulatedSource → Web Worker local (shm_worker.js) con telemetría sintética.
//   · LiveSource      → WebSocket a la nube (gateway → Worker Cloudflare → WS).
// Por defecto usa la simulación. Para datos reales: new DataSource({ liveUrl })
// (en la app se toma de ?live=wss://…). Si la conexión live falla, cae a simulación.
// El dashboard y la vista no saben cuál fuente está activa.
// ─────────────────────────────────────────────────────────────────────────────
import { getBackendConfig, createBackend } from './backend.js?v=318';

export class DataSource {
  constructor(opts = {}) {
    this.latest = {};
    this.onTick = null;
    this._mode = 'sim';
    this._initMsg = null;
    this._focusId = null;
    this._ws = null;
    this.worker = null;
    this.backend = null;
    const beCfg = opts.backend || getBackendConfig();
    if (opts.liveUrl) this._connectLive(opts.liveUrl);
    else if (beCfg) this._startBackend(opts.backend && typeof opts.backend.onTick === 'function' ? opts.backend : createBackend(beCfg));
    else this._startSim();
  }

  // Backend (Supabase o mock): el worker local actúa de INGESTOR (en producción,
  // el Pi) → persiste cada tick; el backend re-emite lo persistido al dashboard.
  _startBackend(backend) {
    this.backend = backend;
    this._mode = 'backend:' + backend.mode;
    this._unsub = backend.onTick((tick) => this._handleTick(tick));
    this.worker = new Worker(new URL('./shm_worker.js?v=318', import.meta.url));
    this.worker.onmessage = (e) => { const m = e.data; if (m && m.type === 'tick') backend.ingestTick(m); };
    if (this._initMsg) this.worker.postMessage(this._initMsg);
    if (this._focusId) this.worker.postMessage({ type: 'focus', id: this._focusId });
  }

  _handleTick(m) { if (m && m.type === 'tick') { this.latest = m.summaries; this.onTick?.(m); } }

  _startSim() {
    this._mode = 'sim';
    this.worker = new Worker(new URL('./shm_worker.js?v=318', import.meta.url));
    this.worker.onmessage = (e) => this._handleTick(e.data);
    if (this._initMsg) this.worker.postMessage(this._initMsg);
    if (this._focusId) this.worker.postMessage({ type: 'focus', id: this._focusId });
  }

  _connectLive(url) {
    this._mode = 'live-connecting';
    try {
      const ws = new WebSocket(url); this._ws = ws;
      ws.onopen = () => {
        this._mode = 'live';
        if (this._initMsg) ws.send(JSON.stringify(this._initMsg));
        if (this._focusId) ws.send(JSON.stringify({ type: 'focus', id: this._focusId }));
      };
      ws.onmessage = (e) => { try { this._handleTick(JSON.parse(e.data)); } catch {} };
      ws.onerror = () => { if (this._mode !== 'live') { console.warn('[DataSource] live no disponible → simulación'); this._startSim(); } };
    } catch { this._startSim(); }
  }

  _send(msg) {
    if (this._mode === 'live' && this._ws?.readyState === 1) this._ws.send(JSON.stringify(msg));
    else if (this.worker) this.worker.postMessage(msg);
  }

  /** structs: [{id, type, f1, dmg, sensors:[{id,status}]}] */
  init(structs) { this._initMsg = { type: 'init', structs }; this._send(this._initMsg); }
  /** Estructura enfocada → su señal temporal en detalle. */
  focus(id) { this._focusId = id; this._send({ type: 'focus', id }); }
  get(id) { return this.latest[id] || null; }
  get mode() { return this._mode; }
}
