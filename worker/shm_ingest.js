// ─────────────────────────────────────────────────────────────────────────────
// shm_ingest.js — SCAFFOLD del backend de ingesta SHM (Cloudflare Worker + Durable
// Object). Conecta el gateway real con la app (LiveSource de data_source.js).
//
//   gateway  --HTTP POST /ingest-->  Worker  --> Durable Object (estado + fan-out)
//   navegador --WebSocket /ws------>  Durable Object  --tick JSON-->  navegador
//
// El navegador se conecta con:  ReWind  ?live=wss://<tu-worker>/ws
// El formato de los mensajes es el MISMO que emite shm_worker.js:
//   { type:'tick', t, summaries:{ id:{ f1,temp,rms,dmg, sensors:[{id,status,rms}] } }, waves:{...} }
//
// NO está desplegado: requiere añadir el binding del Durable Object en wrangler.jsonc
// y `npx wrangler deploy`. Ver docs/wind-shm-issues.md (backlog · LiveSource).
//
// wrangler.jsonc (añadir):
//   "durable_objects": { "bindings": [{ "name": "SHM_HUB", "class_name": "ShmHub" }] },
//   "migrations": [{ "tag": "v1", "new_classes": ["ShmHub"] }]
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Un solo hub global (o usa idFromName(parqueId) para multi-parque).
    const id = env.SHM_HUB.idFromName('parque');
    const hub = env.SHM_HUB.get(id);
    if (url.pathname === '/ws' || url.pathname === '/ingest') return hub.fetch(request);
    return new Response('ReWind SHM ingest', { status: 200 });
  },
};

export class ShmHub {
  constructor(state) { this.state = state; this.clients = new Set(); this.latest = {}; }

  async fetch(request) {
    const url = new URL(request.url);

    // ── Navegador: WebSocket de salida (recibe ticks) ──
    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.clients.add(server);
      // primer estado conocido
      if (Object.keys(this.latest).length) server.send(JSON.stringify({ type: 'tick', t: Date.now() / 1000, summaries: this.latest, waves: {} }));
      server.addEventListener('message', (e) => {
        // el cliente manda {type:'init'|'focus'} — aquí se podría filtrar por estructura
        try { JSON.parse(e.data); } catch {}
      });
      server.addEventListener('close', () => this.clients.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Gateway: POST /ingest con telemetría {id, sensors:[{id,status,accel,...}]} ──
    if (url.pathname === '/ingest' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body) return new Response('bad json', { status: 400 });
      // Construye el summary por estructura y difunde a los navegadores conectados.
      const tick = this._toTick(body);
      this.latest = { ...this.latest, ...tick.summaries };
      const msg = JSON.stringify(tick);
      for (const ws of this.clients) { try { ws.send(msg); } catch { this.clients.delete(ws); } }
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  // Mapea el payload del gateway al formato de tick que consume el dashboard.
  _toTick(body) {
    // body esperado (ejemplo): { id:'WT-01', f1, temp, dmg, sensors:[{id,status,rms,samples?}] }
    const id = body.id;
    const sensors = (body.sensors || []).map(s => ({ id: s.id, status: s.status || 'ok', rms: s.rms || 0 }));
    const rms = sensors.reduce((m, s) => Math.max(m, s.rms), 0);
    const summaries = { [id]: { f1: body.f1 || 0, temp: body.temp || 0, rms, dmg: body.dmg || 0, sensors } };
    const waves = {};
    const withSamples = (body.sensors || []).filter(s => Array.isArray(s.samples));
    if (withSamples.length) waves[id] = withSamples.map(s => ({ id: s.id, status: s.status || 'ok', samples: s.samples }));
    return { type: 'tick', t: Date.now() / 1000, summaries, waves };
  }
}
