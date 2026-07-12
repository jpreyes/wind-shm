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
  // Headers dinámicos: si hay sesión de usuario vigente (auth.js escribe
  // `rewind.auth.v1`), el Bearer es su access token → los requests corren como
  // `authenticated` y el RLS de producción los gobierna. Sin sesión, cae a la
  // anon/publishable key (piloto con RLS abierto). No importamos auth.js: leemos
  // el token directo de localStorage para evitar dependencia circular.
  function headers() {
    let token = cfg.anonKey;
    try {
      const s = JSON.parse(localStorage.getItem('rewind.auth.v1'));
      if (s && s.access_token && (s.expires_at * 1000) > Date.now()) token = s.access_token;
    } catch { /* */ }
    return { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }
  const subs = new Set();
  let pollTimer = null, sinceTs = null, lastIngest = 0;
  const INGEST_MS = 60000;   // features 1/min: no golpear Supabase en cada tick del sim
  const POLL_FAST = 5000, POLL_SLOW = 30000;   // polling: rápido; lento cuando Realtime está vivo

  // Convierte filas de `features` en un tick y lo entrega a los suscriptores. Los
  // updates son idempotentes (fija el último estado por estructura) → da igual que
  // una fila llegue por Realtime y por polling.
  function deliver(rows) {
    if (!rows || !rows.length) return;
    sinceTs = rows[rows.length - 1].ts || sinceTs;
    const summaries = {};
    for (const r of rows) summaries[r.structure_id] = { f1: r.f1, f2: r.f2, rms: r.rms, wind: r.wind, temp: r.temp, tilt: r.tilt, cls: r.cls, sensors: [] };
    const tick = { type: 'tick', t: Date.now(), summaries, waves: {} };
    for (const cb of subs) cb(tick);
  }

  async function poll() {
    try {
      const since = sinceTs ? `&ts=gt.${encodeURIComponent(sinceTs)}` : '&limit=200';
      const res = await fetch(`${base}/rest/v1/features?select=*&order=ts.asc${since}`, { headers: headers() });
      if (res.ok) deliver(await res.json());
    } catch { /* red intermitente → reintenta */ }
    pollTimer = setTimeout(poll, rtConnected ? POLL_SLOW : POLL_FAST);
  }

  // ── Realtime nativo (WebSocket Phoenix) para INSERT en `features` ─────────────
  // Baja latencia sin supabase-js. El polling queda de red de seguridad (a 30 s
  // mientras RT esté vivo). Reconexión con backoff. RLS: manda el token de sesión.
  let ws = null, hbTimer = null, rtRef = 0, rtRetry = 0, rtConnected = false;
  const RT_TOPIC = 'realtime:rewind-features';
  function rtToken() {
    try { const s = JSON.parse(localStorage.getItem('rewind.auth.v1')); if (s && s.access_token && (s.expires_at * 1000) > Date.now()) return s.access_token; } catch { /* */ }
    return cfg.anonKey;
  }
  function startRealtime() {
    if (typeof WebSocket === 'undefined') return;
    let sock; try { sock = new WebSocket(base.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent(cfg.anonKey)}&vsn=1.0.0`); } catch { return; }
    ws = sock;
    sock.onopen = () => {
      rtRetry = 0;
      sock.send(JSON.stringify({ topic: RT_TOPIC, event: 'phx_join', ref: String(++rtRef),
        payload: { access_token: rtToken(), config: { postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'features' }] } } }));
      clearInterval(hbTimer);
      hbTimer = setInterval(() => { if (sock.readyState === 1) sock.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++rtRef) })); }, 25000);
    };
    sock.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.event === 'phx_reply' && m.topic === RT_TOPIC && m.payload?.status === 'ok') { rtConnected = true; return; }
      if (m.event === 'postgres_changes') { const rec = m.payload?.data?.record; if (rec) deliver([rec]); }
    };
    const down = () => {
      if (ws !== sock) return;               // ya reemplazado
      rtConnected = false; clearInterval(hbTimer); hbTimer = null; ws = null;
      if (subs.size) setTimeout(startRealtime, Math.min(30000, 2000 * (2 ** Math.min(rtRetry++, 4))));   // backoff
    };
    sock.onerror = down; sock.onclose = down;
  }
  function stopRealtime() {
    rtConnected = false; clearInterval(hbTimer); hbTimer = null;
    if (ws) { const s = ws; ws = null; try { s.onclose = null; s.close(); } catch { /* */ } }
  }

  return {
    mode: 'supabase',
    async ingestTick(tick) {
      const now = Date.now();
      if (now - lastIngest < INGEST_MS) return;   // throttle: máx. 1 lote/min (contrato «features 1/min»)
      lastIngest = now;
      const rows = tickToRows(tick);
      if (rows.length) fetch(`${base}/rest/v1/features`, { method: 'POST', headers: headers(), body: JSON.stringify(rows) }).catch(() => {});
    },
    onTick(cb) {
      subs.add(cb);
      if (!pollTimer) poll();          // red de seguridad
      if (!ws) startRealtime();        // baja latencia
      return () => {
        subs.delete(cb);
        if (!subs.size) { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } stopRealtime(); }
      };
    },
    latest() { return {}; },
    async insert(table, rows) {
      const res = await fetch(`${base}/rest/v1/${table}`, { method: 'POST', headers: { ...headers(), Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows) });
      return { ok: res.ok, status: res.status };
    },
    async select(table, query = '') {
      const res = await fetch(`${base}/rest/v1/${table}?select=*${query}`, { headers: headers() });
      return res.ok ? res.json() : [];
    },
    async remove(table, id) {
      const res = await fetch(`${base}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() });
      return { ok: res.ok };
    },
    async count(table) {
      // HEAD + Prefer count=exact → total en el header Content-Range («*/N»).
      try {
        const res = await fetch(`${base}/rest/v1/${table}?select=*`, { method: 'HEAD', headers: { ...headers(), Prefer: 'count=exact', Range: '0-0' } });
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
