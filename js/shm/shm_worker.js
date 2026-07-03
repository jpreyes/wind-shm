// ─────────────────────────────────────────────────────────────────────────────
// shm_worker.js — Web Worker de TELEMETRÍA SINTÉTICA (ReWind).
//
// Genera datos realistas por estructura/sensor mientras se conectan los sensores
// reales. Es la implementación «SimulatedSource»: cuando llegue la nube/gateway,
// se reemplaza por un «LiveSource» con el MISMO formato de mensaje y nada más cambia.
//
// Mensajes que recibe:  {type:'init', structs:[...]}  ·  {type:'focus', id}
// Mensajes que emite:    {type:'tick', t, summaries:{id:{...}}, waves:{id:[...]}}
// ─────────────────────────────────────────────────────────────────────────────
let structs = [];
let focus = null;
let timer = null;
const FS = 62.5;          // frecuencia de muestreo simulada (Hz)
const N = 5;              // muestras por tick para la estructura enfocada

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    structs = (m.structs || []).map(s => ({
      id: s.id, type: s.type, f1: s.f1 || 0.3, dmg: s.dmg || 0, built: s.built ?? 1,
      sensors: (s.sensors || []).map(se => ({ id: se.id, status: se.status || 'ok' })),
    }));
    start();
  } else if (m.type === 'focus') {
    focus = m.id;
  }
};

function start() { if (timer) clearInterval(timer); timer = setInterval(tick, 80); }

function tick() {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  const summaries = {}, waves = {};
  for (const s of structs) {
    // R-40e: torre en montaje (built<0.97) → sin datos operacionales (standby).
    const standby = (s.built ?? 1) < 0.97;
    // f₁ con leve deriva + caída por daño (indicador SHM)
    const f1 = s.f1 * (1 - s.dmg * 0.04) + (Math.random() - 0.5) * 0.002;
    const temp = 18 + 7 * Math.sin(now * 0.04 + s.id.length) + (Math.random() - 0.5);
    // Velocidad del viento (m/s) — racheada, varía por torre (parque eólico)
    const wind = Math.max(0, 7 + 3.5 * Math.sin(now * 0.05 + s.id.length * 0.7) + 1.8 * Math.sin(now * 0.9 + s.id.length) + (Math.random() - 0.5));
    let rms = 0;
    const sensors = s.sensors.map(se => {
      const ok = se.status === 'ok';
      const amp = se.id.includes('mid') ? 0.5 : 1;
      // En montaje los acelerómetros aún no están operativos → sin RMS.
      const r = standby ? 0 : (ok ? (0.018 + 0.012 * Math.abs(Math.sin(now * 0.3 + se.id.length)) + Math.random() * 0.004) * amp
                   : 0.001 * Math.random());
      rms = Math.max(rms, r);
      return { id: se.id, status: standby ? 'standby' : se.status, rms: r };
    });
    // Clasificador ML (simulado): nivel de daño 0..4 desde daño + estado de sensores.
    let cls = s.dmg < 0.05 ? 0 : s.dmg < 0.15 ? 1 : s.dmg < 0.30 ? 2 : s.dmg < 0.50 ? 3 : 4;
    if (sensors.some(se => se.status === 'fault')) cls = Math.max(cls, 2);
    // Standby: sin clase de daño ni RMS operacional; se conserva f₁ (predicha del
    // gemelo) y viento/temp (ambientales). El flag `standby` lo consume la UI.
    summaries[s.id] = standby ? { f1, temp, wind, dmg: 0, cls: 0, rms: 0, sensors, standby: true }
                              : { f1, temp, wind, dmg: s.dmg, cls, rms, sensors };

    if (s.id === focus) {
      waves[s.id] = s.sensors.map(se => {
        const amp = se.id.includes('mid') ? 0.5 : 1;
        const out = [];
        for (let i = 0; i < N; i++) {
          const tt = now + i / FS;
          out.push(se.status === 'ok'
            ? (Math.sin(2 * Math.PI * f1 * tt) + 0.35 * Math.sin(2 * Math.PI * f1 * 6 * tt)
               + 0.18 * (Math.random() - 0.5)) * amp
            : 0.12 * (Math.random() - 0.5));   // sensor en falla: ruido plano
        }
        return { id: se.id, status: se.status, samples: out };
      });
    }
  }
  self.postMessage({ type: 'tick', t: now, summaries, waves });
}
