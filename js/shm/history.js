// ─────────────────────────────────────────────────────────────────────────────
// history.js — Frente 2 · R-34 · histórico persistente de series (IndexedDB).
//
// Guarda por estructura una serie temporal decimada (1 punto/min) de f₁, RMS,
// viento y tilt, con retención rodante (purga en boot lo más viejo que N días).
// IndexedDB NATIVO (sin libs). El `freqHist` en memoria moría al recargar; esto
// sobrevive y alimenta la subpestaña «Tendencia».
//
// API:  await Hist.record(structId, {t, f1, rms, wind, tilt})   // decima a 1/min
//       await Hist.range(structId, sinceTs) → [{s,t,f1,rms,wind,tilt}, …]
//       await Hist.purge(retentionDays?)     // borra lo anterior al corte
//       await Hist.count()                   // nº de muestras (debug/estado)
// ─────────────────────────────────────────────────────────────────────────────
const DB_NAME = 'rewind-history';
const STORE = 'samples';
const DB_VER = 1;
const MIN_INTERVAL = 60_000;     // 1 muestra/min por estructura (decimación)
const RETENTION_DAYS = 60;       // retención rodante

let _db = null;
const _last = {};                // structId → ts de la última escritura (decimación en memoria)
const _ok = typeof indexedDB !== 'undefined';

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'k', autoIncrement: true });
        os.createIndex('struct_ts', ['s', 't']);   // rango por estructura+tiempo
        os.createIndex('t', 't');                   // purga por tiempo global
      }
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}

// Registra una muestra si pasó ≥1 min desde la última de esa estructura.
export async function record(structId, sample = {}) {
  if (!_ok) return;
  const now = sample.t || Date.now();
  if (_last[structId] && now - _last[structId] < MIN_INTERVAL) return;
  _last[structId] = now;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add({
      s: structId, t: now,
      f1: sample.f1 ?? null, rms: sample.rms ?? null,
      wind: sample.wind ?? null, tilt: sample.tilt ?? null,
    });
  } catch { /* IDB no disponible (modo privado, etc.) → sin histórico */ }
}

// Muestras de una estructura desde `sinceTs` (orden ascendente por tiempo).
export async function range(structId, sinceTs = 0) {
  if (!_ok) return [];
  try {
    const db = await openDB();
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readonly');
      const idx = tx.objectStore(STORE).index('struct_ts');
      // [struct, sinceTs] … [struct, []] — el array ordena DESPUÉS de cualquier número.
      const rng = IDBKeyRange.bound([structId, sinceTs], [structId, []]);
      const out = [];
      idx.openCursor(rng).onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
    });
  } catch { return []; }
}

// Borra lo anterior a `retentionDays` (retención rodante). Devuelve nº borrado.
export async function purge(retentionDays = RETENTION_DAYS) {
  if (!_ok) return 0;
  const cutoff = Date.now() - retentionDays * 864e5;
  try {
    const db = await openDB();
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('t');
      let n = 0;
      idx.openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = (e) => {
        const c = e.target.result; if (c) { c.delete(); n++; c.continue(); } else res(n);
      };
    });
  } catch { return 0; }
}

export async function count() {
  if (!_ok) return 0;
  try {
    const db = await openDB();
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).count();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(0);
    });
  } catch { return 0; }
}
