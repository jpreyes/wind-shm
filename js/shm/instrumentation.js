// ─────────────────────────────────────────────────────────────────────────────
// instrumentation.js — instrumentación EDITABLE por estructura (ReWind · R-33).
//
// Permite añadir/quitar/configurar sensores definidos por el usuario, además de
// los de fábrica (2 MEMS + gateway por turbina, 4 nodos por torre AT). Cada sensor
// lleva tipo, etiqueta y altura (`yFrac` 0..1) → se dibuja como callout del HUD a
// esa altura y se lista en la pestaña Sensores. Persiste en localStorage.
//
// El valor en vivo es SINTÉTICO y determinista por sensor/tipo hasta conectar el
// hardware real (DataSource/`R-10`). Módulo de datos puro (sin DOM/Three.js).
// ─────────────────────────────────────────────────────────────────────────────
import { t } from './i18n.js?v=288';

const KEY = 'rewind.instrumentation.v1';
let _seq = 0;
const uid = () => 'cs' + Date.now().toString(36) + (++_seq).toString(36);

// Tipos de sensor: clave estable + icono + unidad (la etiqueta se traduce en la UI).
export const SENSOR_TYPES = [
  { key: 'acc', icon: '📡', unit: 'mg', dec: 1 },
  { key: 'tilt', icon: '📐', unit: '°', dec: 2 },
  { key: 'strain', icon: '〰️', unit: 'µε', dec: 0 },
  { key: 'temp', icon: '🌡️', unit: '°C', dec: 1 },
];
export const typeOf = (key) => SENSOR_TYPES.find(x => x.key === key) || SENSOR_TYPES[0];
export const typeLabel = (key) => t('instr.t.' + (typeOf(key).key));
export const typeIcon = (key) => typeOf(key).icon;

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {} }

/** Sensores definidos por el usuario para una estructura. */
export function getSensors(structId) { return load()[structId] || []; }

export function addSensor(structId, s) {
  const o = load();
  (o[structId] ||= []).push({ id: uid(), type: s.type || 'acc', label: (s.label || '').trim(), yFrac: clamp01(s.yFrac ?? 0.6) });
  save(o);
  return o[structId];
}

export function removeSensor(structId, id) {
  const o = load(); o[structId] = (o[structId] || []).filter(x => x.id !== id); save(o);
}

export function updateSensor(structId, id, patch) {
  const o = load(); const s = (o[structId] || []).find(x => x.id === id);
  if (s) { Object.assign(s, patch); if (patch.yFrac != null) s.yFrac = clamp01(patch.yFrac); save(o); }
}

const clamp01 = (v) => Math.max(0, Math.min(1, +v || 0));

// Hash determinista 0..1 desde el id (para fijar la fase del valor sintético).
function hash01(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

// Valor EN VIVO sintético por tipo (determinista + suave en el tiempo). Devuelve
// { value, unit, dec, label }. tSec en segundos (performance.now()/1000).
export function liveValue(s, tSec = 0) {
  const T = typeOf(s.type), ph = hash01(s.id) * 6.2832, h = hash01(s.id + 'x');
  let v;
  switch (s.type) {
    case 'tilt':   v = 0.12 + 0.18 * Math.abs(Math.sin(tSec * 0.25 + ph)) + 0.1 * h; break;          // °
    case 'strain': v = 50 + 90 * Math.abs(Math.sin(tSec * 0.5 + ph)) + 60 * h; break;                // µε
    case 'temp':   v = 16 + 6 * Math.sin(tSec * 0.04 + ph) + 2 * h; break;                            // °C
    default:       v = 12 + 16 * Math.abs(Math.sin(tSec * 0.6 + ph)) + 8 * h; break;                  // mg (acc)
  }
  return { value: v, unit: T.unit, dec: T.dec, label: s.label || typeLabel(s.type) };
}

// Formato compacto "valor unidad" para mostrar en la UI/HUD.
export function fmtLive(s, tSec = 0) { const lv = liveValue(s, tSec); return `${lv.value.toFixed(lv.dec)} ${lv.unit}`; }
