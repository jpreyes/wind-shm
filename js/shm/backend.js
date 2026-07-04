// ─────────────────────────────────────────────────────────────────────────────
// backend.js — capa de backend OPCIONAL (Supabase) con mock local. Sprint 0.
//
// Sin configuración → backend MOCK (pub/sub en memoria): prueba el loop
// produce→persistir→suscribir→render sin depender de nada externo. Con config
// (URL + anon key de Supabase) → backend real vía PostgREST (fetch) + polling de
// la tabla `features`. La app no cambia: `DataSource` enruta los ticks por aquí.
//
// Config: localStorage `rewind.backend.v1` = { url, anonKey }, o el parámetro
// `?backend=<url>|<anonKey>`. Sin dependencias (fetch/WebSocket nativos).
// ─────────────────────────────────────────────────────────────────────────────
const CFG_KEY = 'rewind.backend.v1';

export function getBackendConfig() {
  try {
    const q = new URLSearchParams(location.search).get('backend');
    if (q === 'mock') return { mock: true };                       // fuerza el backend mock (prueba el loop)
    if (q && q.includes('|')) { const [url, anonKey] = q.split('|'); return { url, anonKey }; }
  } catch { /* */ }
  try { const c = JSON.parse(localStorage.getItem(CFG_KEY)); if (c && (c.url || c.mock)) return c; } catch { /* */ }
  return null;
}
export function setBackendConfig(cfg) {
  try {
    if (cfg && cfg.url) localStorage.setItem(CFG_KEY, JSON.stringify({ url: cfg.url, anonKey: cfg.anonKey || '' }));
    else localStorage.removeItem(CFG_KEY);
  } catch { /* */ }
}

// Compacta las features de un tick (una fila por estructura) para persistir.
function tickToRows(tick) {
  const rows = [];
  for (const id in (tick.summaries || {})) {
    const s = tick.summaries[id];
    rows.push({ structure_id: id, f1: s.f1 ?? null, f2: s.f2 ?? null, rms: s.rms ?? null, wind: s.wind ?? null, temp: s.temp ?? null, tilt: s.tilt ?? null, cls: s.cls ?? null });
  }
  return rows;
}

// ── Mock: pub/sub + tablas en memoria (el loop y el CRUD completos sin Supabase) ─
function mockBackend() {
  const subs = new Set();
  const last = {};
  const tables = {};   // name → filas (upsert por `id` si lo trae)
  return {
    mode: 'mock',
    async ingestTick(tick) {
      for (const r of tickToRows(tick)) last[r.structure_id] = { ...r, ts: tick.t || Date.now() };
      queueMicrotask(() => { for (const cb of subs) cb(tick); });   // echo → render
    },
    onTick(cb) { subs.add(cb); return () => subs.delete(cb); },
    latest() { return { ...last }; },
    async insert(table, rows) {
      const arr = tables[table] ??= [];
      for (const r of [].concat(rows)) {
        if (r.id != null) { const i = arr.findIndex((x) => x.id === r.id); if (i >= 0) arr[i] = r; else arr.push(r); }
        else arr.push({ ...r });
      }
      return { ok: true, mock: true, count: [].concat(rows).length };
    },
    async select(table) { return (tables[table] || []).slice(); },
    async count(table) { return (tables[table] || []).length; },
    async remove(table, id) { if (tables[table]) tables[table] = tables[table].filter((x) => x.id !== id); return { ok: true }; },
  };
}

// ── Supabase: PostgREST (fetch) + polling de `features` ───────────────────────
function supabaseBackend(cfg) {
  const base = cfg.url.replace(/\/$/, '');
  const headers = { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}`, 'Content-Type': 'application/json' };
  const subs = new Set();
  let pollTimer = null, sinceTs = null, lastIngest = 0;
  const INGEST_MS = 60000;   // features 1/min: no golpear Supabase en cada tick del sim

  async function poll() {
    try {
      const since = sinceTs ? `&ts=gt.${encodeURIComponent(sinceTs)}` : '&limit=200';
      const res = await fetch(`${base}/rest/v1/features?select=*&order=ts.asc${since}`, { headers });
      if (res.ok) {
        const rows = await res.json();
        if (rows.length) {
          sinceTs = rows[rows.length - 1].ts;
          const summaries = {};
          for (const r of rows) summaries[r.structure_id] = { f1: r.f1, f2: r.f2, rms: r.rms, wind: r.wind, temp: r.temp, tilt: r.tilt, cls: r.cls, sensors: [] };
          const tick = { type: 'tick', t: Date.now(), summaries, waves: {} };
          for (const cb of subs) cb(tick);
        }
      }
    } catch { /* red intermitente → reintenta */ }
    pollTimer = setTimeout(poll, 5000);
  }

  return {
    mode: 'supabase',
    async ingestTick(tick) {
      const now = Date.now();
      if (now - lastIngest < INGEST_MS) return;   // throttle: máx. 1 lote/min (contrato «features 1/min»)
      lastIngest = now;
      const rows = tickToRows(tick);
      if (rows.length) fetch(`${base}/rest/v1/features`, { method: 'POST', headers, body: JSON.stringify(rows) }).catch(() => {});
    },
    onTick(cb) { subs.add(cb); if (!pollTimer) poll(); return () => { subs.delete(cb); if (!subs.size && pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }; },
    latest() { return {}; },
    async insert(table, rows) {
      const res = await fetch(`${base}/rest/v1/${table}`, { method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows) });
      return { ok: res.ok, status: res.status };
    },
    async select(table, query = '') {
      const res = await fetch(`${base}/rest/v1/${table}?select=*${query}`, { headers });
      return res.ok ? res.json() : [];
    },
    async remove(table, id) {
      const res = await fetch(`${base}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      return { ok: res.ok };
    },
    async count(table) {
      // HEAD + Prefer count=exact → total en el header Content-Range («*/N»).
      try {
        const res = await fetch(`${base}/rest/v1/${table}?select=*`, { method: 'HEAD', headers: { ...headers, Prefer: 'count=exact', Range: '0-0' } });
        const cr = res.headers.get('content-range'); const n = cr ? +cr.split('/')[1] : NaN;
        return Number.isFinite(n) ? n : (res.ok ? 0 : null);
      } catch { return null; }
    },
  };
}

export function createBackend(cfg = getBackendConfig()) {
  return cfg && cfg.url ? supabaseBackend(cfg) : mockBackend();
}

// Expuesto para configurar desde consola/UI sin recompilar (la anon key es pública).
if (typeof window !== 'undefined') window.shmBackendConfig = (url, anonKey) => { setBackendConfig(url ? { url, anonKey } : null); return getBackendConfig(); };
