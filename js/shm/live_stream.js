// ─────────────────────────────────────────────────────────────────────────────
// live_stream.js — streaming EN VIVO (tiempo real de verdad) de la aceleración del
// sensor vía Supabase Realtime **Broadcast** (canal efímero, sin tocar la BD).
//
// Modelo de operación (producción SHM): en NORMAL el sensor manda ventanas de 5 min
// cada 60 min (batched, barato). En EVENTO — on-demand o anomalía — el sensor abre
// un WebSocket de SALIDA a Supabase y EMITE chunks de aceleración (~0.2 s) al canal
// `realtime:live:<structureId>`; el navegador (también saliente) los recibe con <1 s
// de latencia. Preserva el diseño outbound-only (CGNAT/Starlink, sin puertos).
//
// openLive(id, onChunk, onState) → devuelve stop(). onChunk({fs,ax,ay,az,sensor,trigger}).
// onState: 'connecting' | 'idle' (canal vivo, sin flujo) | 'live' (llegando chunks) | 'closed'.
// ─────────────────────────────────────────────────────────────────────────────
import { getBackendConfig } from './backend.js?v=331';

// Token de sesión (RLS) o, si no hay, la publishable key (canal público).
function authToken(anonKey) {
  try { const s = JSON.parse(localStorage.getItem('rewind.auth.v1')); if (s && s.access_token && (s.expires_at * 1000) > Date.now()) return s.access_token; } catch { /* */ }
  return anonKey;
}

export function openLive(structureId, onChunk, onState) {
  const cfg = getBackendConfig();
  if (!cfg?.url || typeof WebSocket === 'undefined') { onState?.('unavailable'); return () => {}; }
  const base = cfg.url.replace(/\/$/, '');
  const topic = `realtime:live:${structureId}`;
  let ws = null, hb = null, ref = 0, closed = false, idleT = null, retry = 0;

  // Marca 'live' mientras lleguen chunks; vuelve a 'idle' tras 4 s de silencio.
  const bump = () => { onState?.('live'); clearTimeout(idleT); idleT = setTimeout(() => { if (!closed) onState?.('idle'); }, 4000); };

  const connect = () => {
    try { ws = new WebSocket(base.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent(cfg.anonKey)}&vsn=1.0.0`); }
    catch { onState?.('closed'); return; }
    onState?.('connecting');
    ws.onopen = () => {
      retry = 0;
      ws.send(JSON.stringify({ topic, event: 'phx_join', ref: String(++ref),
        payload: { config: { broadcast: { self: false }, private: false }, access_token: authToken(cfg.anonKey) } }));
      clearInterval(hb);
      hb = setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) })); }, 25000);
      onState?.('idle');
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.topic === topic && m.event === 'broadcast') {
        const p = (m.payload && m.payload.payload) || m.payload;   // Phoenix anida payload.payload
        if (p) { try { onChunk(p); } catch { /* */ } bump(); }
      }
    };
    const down = (thisWs) => () => {
      if (ws !== thisWs) return;
      clearInterval(hb); hb = null; ws = null;
      if (!closed) setTimeout(connect, Math.min(20000, 1500 * (2 ** Math.min(retry++, 3))));   // backoff
    };
    ws.onerror = down(ws); ws.onclose = down(ws);
  };
  connect();

  return () => {
    closed = true; clearInterval(hb); clearTimeout(idleT);
    if (ws) { const s = ws; ws = null; try { s.onclose = null; s.close(); } catch { /* */ } }
    onState?.('closed');
  };
}
