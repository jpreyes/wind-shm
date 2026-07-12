// ─────────────────────────────────────────────────────────────────────────────
// backend_sync.js — sincroniza el modelo canónico de ReWind con el backend
// (Supabase o mock). Sprint 0.5: calidad (protocolos/ensayos), WBS y perfiles.
//
// El backend es la fuente de verdad cuando está configurado; localStorage queda
// como CACHÉ OFFLINE. Sin backend configurado, todo funciona como antes (no-op).
// Mapeo modelo↔fila explícito (nombres de columna del esquema en snake_case).
// ─────────────────────────────────────────────────────────────────────────────
import { getBackendConfig, createBackend } from './backend.js?v=330';
import { decodeNpz } from './npz.js?v=330';

let _be = null, _cfgKey = null;
// Instancia perezosa del backend; se recrea si cambia la config.
export function backend() {
  const cfg = getBackendConfig();
  const key = cfg ? JSON.stringify(cfg) : null;
  if (key !== _cfgKey) { _cfgKey = key; _be = cfg ? createBackend(cfg) : null; }
  return _be;
}
export function backendActive() { return !!getBackendConfig(); }

// ── Mapeo protocolo canónico ↔ fila `protocolos` ──────────────────────────────
function protoRow(p, overrides = {}) {
  return {
    id: p.id, structure_id: p.estructuraId || null, item: p.item ?? null,
    codigo: p.codigoDocumento || null, area: p.area || null, elemento: p.elemento || null,
    hito_pago: p.hitoPago || null, especialidad: p.especialidad || null,
    descripcion: p.descripcion || null, documento: p.documento || null,
    estado: p.estadoActual || null, estado_raw: p.estadoActualRaw || null,
    partida_id: overrides[p.id] || null, meta: {},
  };
}
function rowProto(r) {
  return {
    id: r.id, item: r.item ?? null, codigoDocumento: r.codigo || null, codigoSharepoint: null, hyperlink: null,
    area: r.area || null, elemento: r.elemento || null, estructuraId: r.structure_id || null,
    descripcion: r.descripcion || null, documento: r.documento || null,
    especialidad: r.especialidad || null, hitoPago: r.hito_pago || null,
    fechaDocumento: null, correlativo: null, cicloDocumento: null,
    estadoActual: r.estado || null, estadoActualRaw: r.estado_raw || null,
    ciclos: [], _origen: { backend: true },
  };
}

// ── Estructuras (siembra la flota; protocolos/features la referencian) ────────
export async function pushStructures(fleet) {
  const be = backend(); if (!be || !fleet?.structures) return;
  const rows = fleet.structures.map((s) => ({
    id: s.id, type: s.type || 'turbine', label: s.label || s.id,
    lat: s.lat ?? null, lon: s.lon ?? null, height: s.height ?? null, built: s.built ?? null,
  }));
  if (rows.length) await be.insert('structures', rows);
  return rows.length;
}

// ── Calidad ───────────────────────────────────────────────────────────────────
// Empuja el modelo canónico completo al backend (upsert de protocolos + ensayos).
export async function pushQuality(data, overrides = {}) {
  const be = backend(); if (!be || !data) return { ok: false, skipped: true };
  const rows = (data.protocolos || []).map((p) => protoRow(p, overrides));
  if (rows.length) await be.insert('protocolos', rows);
  const ens = (data.ensayosHormigon || []).map((e) => ({
    id: e.id, structure_id: e.estructuraId || null, tipo: e.tipo || null, grado: e.grado || null,
    norma: e.norma || null, fecha: e.fechaEnsayo || null, estado: e.estadoActual || null, meta: {},
  }));
  if (ens.length) await be.insert('ensayos', ens);
  return { ok: true, protocolos: rows.length, ensayos: ens.length };
}

// Trae los protocolos del backend → modelo canónico (parcial: sin ciclos/raw).
export async function pullQuality() {
  const be = backend(); if (!be) return null;
  const rows = await be.select('protocolos');
  if (!rows || !rows.length) return null;
  return {
    meta: { fuente: 'Supabase', formato: 'backend', importado: new Date().toISOString() },
    protocolos: rows.map(rowProto), ensayosHormigon: [], resumen: [], catalogos: {},
  };
}

export async function deleteProtocoloRemote(id) {
  const be = backend(); if (!be) return; await be.remove('protocolos', id);
}

// ── WBS y perfiles ──────────────────────────────────────────────────────────
export async function pushWbs(type, partidas, overrides = {}, park = 'default') {
  const be = backend(); if (!be) return; await be.insert('wbs_config', [{ id: `${park}:${type}`, park, type, partidas, overrides }]);
}
export async function pushProfile(profile) {
  const be = backend(); if (!be) return; await be.insert('import_profiles', [{ id: `prof:${profile.name}`, name: profile.name, config: profile }]);
}

// ── On-demand: pedir una ventana cruda AHORA (Frente 4, command-polling) ───────
// Inserta un comando `pending`; el sensor lo sondea y sube la ventana. Sin puertos.
export async function requestCapture(structureId, kind = 'window') {
  const be = backend(); if (!be) return { ok: false, skipped: true };
  await be.insert('sensor_commands', [{ structure_id: structureId, kind, status: 'pending' }]);
  markPush();
  return { ok: true };
}

// ── Ventanas crudas (serie temporal del sensor real) ──────────────────────────
// Lee el puntero más reciente de `waves` para la estructura, baja el `.npz` de
// Storage y lo decodifica → { meta, arrays:{ax,ay,az,fs} } o null si no hay/permiso.
// `after` (id o ts) permite esperar una ventana NUEVA (on-demand) e ignorar la vieja.
export async function latestWave(structureId, after = null) {
  const be = backend(); if (!be || !be.storageGet) return null;
  const rows = await be.select('waves', `&structure_id=eq.${encodeURIComponent(structureId)}&order=ts.desc&limit=1`);
  if (!rows || !rows.length) return null;
  const w = rows[0];
  if (after != null && (w.id === after || (w.ts && String(w.ts) <= String(after)))) return { meta: w, arrays: null, stale: true };
  if (!w.storage_path) return { meta: w, arrays: null };
  const buf = await be.storageGet('waves', w.storage_path);
  if (!buf) return { meta: w, arrays: null };
  try {
    const npz = await decodeNpz(buf);
    const pick = (k) => (npz[k]?.data ? Array.from(npz[k].data) : null);
    const fsArr = npz.fs?.data;
    return { meta: w, arrays: { ax: pick('ax'), ay: pick('ay'), az: pick('az'), fs: (fsArr && fsArr[0]) || w.fs || 150 } };
  } catch { return { meta: w, arrays: null }; }
}

// ── Inspecciones (CMMS) ───────────────────────────────────────────────────────
export async function pushInspection(insp, structureId) {
  const be = backend(); if (!be) return;
  await be.insert('inspections', [{
    id: insp.id, structure_id: structureId, inspector: insp.inspector || null,
    date: insp.date || null, score: insp.score ?? null, damages: insp.damages || [], meta: {},
  }]);
}

// ── Estado / visibilidad (Fase 0: «que se vea que entra») ─────────────────────
const COUNT_TABLES = ['structures', 'features', 'protocolos', 'ensayos', 'inspections', 'wbs_config', 'import_profiles'];
export async function tableCounts() {
  const be = backend(); if (!be || !be.count) return null;
  const out = {};
  await Promise.all(COUNT_TABLES.map(async (t) => { try { out[t] = await be.count(t); } catch { out[t] = null; } }));
  return out;
}

// Momento de la última escritura efectiva (para el indicador de sync).
let _lastPush = 0;
export function lastPushAt() { return _lastPush; }
function markPush() { _lastPush = Date.now(); }

// Debounce util para no golpear el backend en cada tecla.
const _timers = {};
export function debouncedPush(key, fn, ms = 1500) {
  clearTimeout(_timers[key]); _timers[key] = setTimeout(async () => { await fn(); markPush(); }, ms);
}
