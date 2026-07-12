// ─────────────────────────────────────────────────────────────────────────────
// parks_data_caman.js — datos georreferenciados del parque «Camán I»
// (Valdivia, Región de Los Ríos, Chile). Extraídos del KMZ del cliente
// (data/CL19 Caman I.kmz): 33 aerogeneradores + 10 torres de la línea de
// transmisión. Coordenadas en WGS84 (lon, lat) — fuente de verdad geográfica.
//
// Para la escena 3D se proyectan a un plano local ENU (metros desde el centro
// del parque) y se comprimen con LAYOUT_SCALE para que la flota quepa cómoda y
// las torres no queden como motas (el parque real mide ~12,6 × 6,5 km).
// Las coordenadas lon/lat se conservan en cada estructura para el futuro mapa 2D.
// ─────────────────────────────────────────────────────────────────────────────

import { CAMAN_ROADS } from './caman_roads.js?v=329';

export const CAMAN_CENTER = { lon: -72.972458, lat: -39.963302 };
export const LAYOUT_SCALE = 0.35;            // 1 m real → 0.35 u de escena

const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos(CAMAN_CENTER.lat * Math.PI / 180);

// lon/lat (WGS84) → posición de escena {x (este), z (−norte)} en unidades 3D.
export function toScene(lon, lat) {
  const east = (lon - CAMAN_CENTER.lon) * M_PER_DEG_LON;
  const north = (lat - CAMAN_CENTER.lat) * M_PER_DEG_LAT;
  return { x: +(east * LAYOUT_SCALE).toFixed(1), z: +(-north * LAYOUT_SCALE).toFixed(1) };
}

// Aerogeneradores: { name, lon, lat, zone } — zona = sector geográfico (3-means en este-oeste).
export const CAMAN_AG = [
  { name: 'T01', lon: -73.045857, lat: -39.992515, zone: 'Poniente' },
  { name: 'T02', lon: -73.041892, lat: -39.991094, zone: 'Poniente' },
  { name: 'T03', lon: -73.046533, lat: -39.985906, zone: 'Poniente' },
  { name: 'T09', lon: -73.017299, lat: -39.974757, zone: 'Poniente' },
  { name: 'T10', lon: -73.011246, lat: -39.974703, zone: 'Poniente' },
  { name: 'T12', lon: -73.003884, lat: -39.981878, zone: 'Poniente' },
  { name: 'T19', lon: -72.996652, lat: -39.959655, zone: 'Poniente' },
  { name: 'T22', lon: -73.011885, lat: -39.961980, zone: 'Poniente' },
  { name: 'T23', lon: -73.006444, lat: -39.959067, zone: 'Poniente' },
  { name: 'T15', lon: -72.985819, lat: -39.973350, zone: 'Centro' },
  { name: 'T21', lon: -72.993483, lat: -39.951096, zone: 'Centro' },
  { name: 'T31', lon: -72.976300, lat: -39.970607, zone: 'Centro' },
  { name: 'T32', lon: -72.968773, lat: -39.970795, zone: 'Centro' },
  { name: 'T34', lon: -72.962863, lat: -39.971543, zone: 'Centro' },
  { name: 'T35', lon: -72.957540, lat: -39.972990, zone: 'Centro' },
  { name: 'T36', lon: -72.952398, lat: -39.968340, zone: 'Centro' },
  { name: 'T37', lon: -72.948287, lat: -39.966906, zone: 'Centro' },
  { name: 'T43', lon: -72.921448, lat: -39.936006, zone: 'Oriente' },
  { name: 'T44', lon: -72.918066, lat: -39.934090, zone: 'Oriente' },
  { name: 'T45', lon: -72.916320, lat: -39.939959, zone: 'Oriente' },
  { name: 'T46', lon: -72.918915, lat: -39.942366, zone: 'Oriente' },
  { name: 'T47', lon: -72.918753, lat: -39.949642, zone: 'Oriente' },
  { name: 'T48', lon: -72.924693, lat: -39.951019, zone: 'Oriente' },
  { name: 'T50', lon: -72.930027, lat: -39.952068, zone: 'Oriente' },
  { name: 'T51', lon: -72.932794, lat: -39.964703, zone: 'Oriente' },
  { name: 'T56', lon: -72.914190, lat: -39.958038, zone: 'Oriente' },
  { name: 'T57', lon: -72.910455, lat: -39.956133, zone: 'Oriente' },
  { name: 'T59', lon: -72.903898, lat: -39.962311, zone: 'Oriente' },
  { name: 'T60', lon: -72.907553, lat: -39.963301, zone: 'Oriente' },
  { name: 'T62', lon: -72.921535, lat: -39.968323, zone: 'Oriente' },
  { name: 'T63', lon: -72.925009, lat: -39.969961, zone: 'Oriente' },
  { name: 'T65', lon: -72.914137, lat: -39.972874, zone: 'Oriente' },
  { name: 'T67', lon: -72.916272, lat: -39.980562, zone: 'Oriente' },
];

// Torres de la línea de transmisión (alta tensión) — todas en el sector Oriente.
export const CAMAN_HV = [
  { name: 'AT-01', lon: -72.910044, lat: -39.962341 },
  { name: 'AT-02', lon: -72.905812, lat: -39.959823 },
  { name: 'AT-03', lon: -72.901425, lat: -39.958600 },
  { name: 'AT-04', lon: -72.900043, lat: -39.958215 },
  { name: 'AT-05', lon: -72.898383, lat: -39.957761 },
  { name: 'AT-06', lon: -72.898671, lat: -39.955631 },
  { name: 'AT-07', lon: -72.898664, lat: -39.953937 },
  { name: 'AT-08', lon: -72.898637, lat: -39.949099 },
  { name: 'AT-09', lon: -72.898617, lat: -39.944009 },
  { name: 'AT-10', lon: -72.898605, lat: -39.942495 },
];

const ZONE_NAMES = ['Poniente', 'Centro', 'Oriente'];

// ── Avance de obra (sintético, determinista por nombre) ──────────────────────
// El parque se está CONSTRUYENDO: hoy solo hay fundaciones. `built` ∈ [0,1] = 0
// (solo fundación) → 1 (torre completa). Se reparte por sector para que se vea
// variado y creíble (poniente más avanzado, oriente recién fundaciones). Es un
// dato editable y persistido; se reemplazará por el avance real vía DataSource.
const hash01 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000) / 1000; };
// Rangos por sector. Poniente llega > 1.0 a propósito (se satura a 1.0) para que un
// grupo quede COMPLETO y operativo (girando), y se vea el contraste con las en obra.
const ZONE_BUILT = { Poniente: [0.7, 1.25], Centro: [0.25, 0.6], Oriente: [0.0, 0.18] };
const builtFor = (name, range) => { const [a, b] = range; return +Math.min(1, Math.max(0, a + (b - a) * hash01(name))).toFixed(2); };

// ── Etapas de obra (4D) — editables por el gestor ────────────────────────────
const STAGE_NAMES = {
  turbine: ['Fundación', 'Montaje de fuste', 'Góndola', 'Rotor', 'Puesta en marcha'],
  hv: ['Fundación', 'Montaje de celosía', 'Tendido de conductores', 'Energización'],
  camino: ['Despeje y limpieza', 'Movimiento de tierras', 'Sub-base granular', 'Base granular', 'Carpeta de rodado'],
  zanja: ['Excavación de zanja', 'Cama de arena', 'Ductos / cable MT', 'Relleno y compactado', 'Malla y señalización'],
  plataforma: ['Despeje y escarpe', 'Mejoramiento de suelo', 'Base granular', 'Compactación y nivel'],
};
const isoDaysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

// Lista de etapas por defecto; cada una con su % de avance (0–100) según `built`.
export function defaultStages(type, built = 0) {
  const names = STAGE_NAMES[type] || STAGE_NAMES.turbine;
  const exact = (built || 0) * names.length, done = Math.floor(exact), frac = exact - done;
  return names.map((name, i) => ({
    name,
    pct: i < done ? 100 : (i === done ? Math.round(frac * 100) : 0),   // la partida en curso lleva % parcial (llenado 4D gradual)
    date: i < done ? isoDaysAgo(15 + (names.length - i) * 9) : '',
  }));
}
// Avance (0..1) = promedio del % de las etapas (admite etapas parciales).
export const builtFromStages = (stages) => (stages && stages.length)
  ? stages.reduce((a, s) => a + (s.pct != null ? s.pct : (s.done ? 100 : 0)), 0) / (stages.length * 100) : 0;

// ── Partidas por COMPONENTE (Frente 1 · HUD de avance) ───────────────────────
// Cada componente físico se ancla a una fracción de la altura de la torre (yFrac)
// para colgar su callout en el 3D, y lleva un ícono para el HUD.
export const TURBINE_COMPONENTS = [
  { component: 'fundacion', label: 'Fundación',            yFrac: 0.04, icon: '▣', durDays: 21 },
  { component: 'fuste',     label: 'Montaje de fuste',     yFrac: 0.52, icon: '▮', durDays: 16 },
  { component: 'gondola',   label: 'Góndola',              yFrac: 1.00, icon: '⬢', durDays: 7 },
  { component: 'rotor',     label: 'Rotor / aspas',        yFrac: 1.07, icon: '✳', durDays: 6 },
  { component: 'cableado',  label: 'Cableado / colectora', yFrac: 0.10, icon: '╲', durDays: 12 },
];
export const HV_COMPONENTS = [
  { component: 'fundacion',    label: 'Fundación',               yFrac: 0.05, icon: '▣', durDays: 14 },
  { component: 'celosia',      label: 'Montaje de celosía',      yFrac: 0.55, icon: '▦', durDays: 18 },
  { component: 'crucetas',     label: 'Crucetas / aisladores',   yFrac: 0.92, icon: '┳', durDays: 6 },
  { component: 'conductores',  label: 'Tendido de conductores',  yFrac: 0.80, icon: '╍', durDays: 9 },
  { component: 'energizacion', label: 'Energización',            yFrac: 0.30, icon: '⚡', durDays: 4 },
];
const RESP = ['Cuadrilla Civil A', 'Cuadrilla Civil B', 'Montajes Sur Ltda.', 'Eléctrica Austral', 'Grúas Patagonia', 'Comisionamiento'];
const DAY = 864e5;
const isoAdd = (baseMs, days) => new Date(baseMs + days * DAY).toISOString().slice(0, 10);

// Enriquece (o migra) las etapas a PARTIDAS por componente con cronograma sintético
// realista y EDITABLE: línea base (plan) + fechas reales con atraso, responsable,
// placeholders de fotos/informes y crosslink al gemelo (twinCheck). Idempotente:
// si una partida ya trae `component`+`plannedStart`, se respeta (datos editados).
export function enrichStages(stages, type = 'turbine', seed = '') {
  const comps = type === 'hv' ? HV_COMPONENTS : TURBINE_COMPONENTS;
  stages = (stages && stages.length) ? stages : defaultStages(type, 0);
  const built = builtFromStages(stages), n = comps.length;
  const doneN = Math.round(built * n), now = Date.now();
  const totalDur = comps.reduce((a, c) => a + c.durDays + 4, 0);
  const startAgo = Math.round(totalDur * (0.45 + 0.9 * built)) + Math.round(hash01(seed) * 20);
  const projStartMs = now - startAgo * DAY;
  let cursor = 0;
  return comps.map((c, i) => {
    const prev = stages[i] || {};
    if (prev.component && prev.plannedStart) return prev;     // ya enriquecida/editada
    const pStart = cursor, pEnd = cursor + c.durDays;
    cursor = pEnd + 3 + Math.round(hash01(seed + c.component) * 5);
    const slip = Math.round((hash01(seed + 's' + c.component) * 2 - 0.4) * 6);   // atraso típico (días)
    const pct = prev.pct != null ? prev.pct
      : (i < doneN ? 100 : (i === doneN ? Math.round(((built * n) % 1) * 100) : 0));
    const done = pct >= 100, started = pct > 0;
    return {
      id: prev.id || (seed + '-' + c.component),
      component: c.component, name: c.label, label: c.label, pct,
      plannedStart: isoAdd(projStartMs, pStart), plannedEnd: isoAdd(projStartMs, pEnd),
      actualStart: started ? isoAdd(projStartMs, pStart + Math.max(0, slip)) : null,
      actualEnd: done ? isoAdd(projStartMs, pEnd + slip) : null,
      responsable: RESP[(i + Math.floor(hash01(seed) * RESP.length)) % RESP.length],
      fotos: prev.fotos || [], informes: prev.informes || [], twinCheck: prev.twinCheck || null,
      date: prev.date || (done ? isoAdd(projStartMs, pEnd + slip) : ''),   // compat con el editor actual
    };
  });
}

// Construye el parque Camán I para el store de parks.js.
// @param makeId  fábrica de ids única (recibe un prefijo) — la provee parks.js.
export function buildCamanPark(makeId) {
  const zones = ZONE_NAMES.map(name => ({ id: makeId('z'), name }));
  const zoneId = Object.fromEntries(zones.map(z => [z.name, z.id]));
  const turbines = CAMAN_AG.map(t => {
    const p = toScene(t.lon, t.lat); const stages = defaultStages('turbine', builtFor(t.name, ZONE_BUILT[t.zone]));
    return { id: t.name, label: t.name, rdspp: `=WTG.${t.name.replace(/\D/g, '')}`, x: p.x, z: p.z, yaw: 0, zone: zoneId[t.zone], lat: t.lat, lon: t.lon, built: builtFromStages(stages), stages };
  });
  const hv = CAMAN_HV.map(t => {
    const p = toScene(t.lon, t.lat); const stages = defaultStages('hv', builtFor(t.name, [0.05, 0.4]));
    return { id: t.name, label: t.name, rdspp: `=LAT.${t.name.replace(/\D/g, '')}`, x: p.x, z: p.z, yaw: 0, zone: zoneId['Oriente'], lat: t.lat, lon: t.lon, built: builtFromStages(stages), stages };
  });
  return { id: makeId('p'), name: 'Camán I', zones, turbines, hv, caminos: camanObraLineal(zones[0].id) };
}

// ── Obra civil LINEAL / de área (reusa geometría real del KMZ) ────────────────
// Estructuras que se «construyen» a lo largo de un path: caminos (vialidad),
// zanjas (colectora de MT) y plataformas (pads de grúa). Cada una con su WBS de
// capas y avance parcial para exhibir el 4D lineal. Exportadas para MIGRAR
// parques ya persistidos. RDS-PP (IEC 81346) por estructura para la trazabilidad.
export function camanCaminos(zoneId) {
  return CAMAN_ROADS.map((seg, i) => {
    const path = seg.map(([lo, la]) => toScene(lo, la));
    const stages = defaultStages('camino', i === 0 ? 0.6 : 0.35);
    const [lon0, lat0] = seg[0] || [CAMAN_CENTER.lon, CAMAN_CENTER.lat];
    return {
      id: `CAM-${String(i + 1).padStart(2, '0')}`, type: 'camino', label: `Camino interior ${i + 1}`,
      rdspp: `=CAM.${String(i + 1).padStart(2, '0')}`, path, width: 7, zone: zoneId || null,
      lat: lat0, lon: lon0, built: builtFromStages(stages), stages,
    };
  });
}
// Zanja de la colectora: corre a lo largo del mismo trazado vial (cable de MT).
export function camanZanjas(zoneId) {
  return CAMAN_ROADS.map((seg, i) => {
    const path = seg.map(([lo, la]) => toScene(lo, la));
    const stages = defaultStages('zanja', 0.45);
    const [lon0, lat0] = seg[0] || [CAMAN_CENTER.lon, CAMAN_CENTER.lat];
    return {
      id: `ZAN-${String(i + 1).padStart(2, '0')}`, type: 'zanja', label: `Colectora — zanja ${i + 1}`,
      rdspp: `=ZAN.${String(i + 1).padStart(2, '0')}`, path, width: 3, zone: zoneId || null,
      lat: lat0, lon: lon0, built: builtFromStages(stages), stages,
    };
  });
}
// Plataformas de grúa/montaje: un pad corto y ancho junto a torres representativas.
export function camanPlataformas(zoneId) {
  const picks = ['T03', 'T15', 'T31'], byName = Object.fromEntries(CAMAN_AG.map(t => [t.name, t]));
  return picks.map((name, i) => {
    const t = byName[name]; if (!t) return null;
    const p = toScene(t.lon, t.lat), half = 17, n = 8;
    // Pad al costado de la torre: path subdividido para que el 4D lo «vierta» gradual.
    const path = Array.from({ length: n + 1 }, (_, k) => ({ x: p.x - half + (2 * half) * k / n, z: p.z + 30 }));
    const stages = defaultStages('plataforma', [0.9, 0.5, 0.2][i] ?? 0.5);
    return {
      id: `PLT-${name}`, type: 'plataforma', label: `Plataforma ${name}`,
      rdspp: `=PLT.${name}`, path, width: 34, zone: zoneId || null,
      lat: t.lat, lon: t.lon, built: builtFromStages(stages), stages,
    };
  }).filter(Boolean);
}
// Toda la obra civil lineal del parque (para siembra y migración).
export function camanObraLineal(zoneId) {
  return [...camanCaminos(zoneId), ...camanZanjas(zoneId), ...camanPlataformas(zoneId)];
}
