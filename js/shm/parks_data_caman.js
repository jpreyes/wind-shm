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
};
const isoDaysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

// Lista de etapas por defecto; cada una con su % de avance (0–100) según `built`.
export function defaultStages(type, built = 0) {
  const names = STAGE_NAMES[type] || STAGE_NAMES.turbine;
  const done = Math.round((built || 0) * names.length);
  return names.map((name, i) => ({ name, pct: i < done ? 100 : 0, date: i < done ? isoDaysAgo(15 + (names.length - i) * 9) : '' }));
}
// Avance (0..1) = promedio del % de las etapas (admite etapas parciales).
export const builtFromStages = (stages) => (stages && stages.length)
  ? stages.reduce((a, s) => a + (s.pct != null ? s.pct : (s.done ? 100 : 0)), 0) / (stages.length * 100) : 0;

// Construye el parque Camán I para el store de parks.js.
// @param makeId  fábrica de ids única (recibe un prefijo) — la provee parks.js.
export function buildCamanPark(makeId) {
  const zones = ZONE_NAMES.map(name => ({ id: makeId('z'), name }));
  const zoneId = Object.fromEntries(zones.map(z => [z.name, z.id]));
  const turbines = CAMAN_AG.map(t => {
    const p = toScene(t.lon, t.lat); const stages = defaultStages('turbine', builtFor(t.name, ZONE_BUILT[t.zone]));
    return { id: t.name, label: t.name, x: p.x, z: p.z, yaw: 0, zone: zoneId[t.zone], lat: t.lat, lon: t.lon, built: builtFromStages(stages), stages };
  });
  const hv = CAMAN_HV.map(t => {
    const p = toScene(t.lon, t.lat); const stages = defaultStages('hv', builtFor(t.name, [0.05, 0.4]));
    return { id: t.name, label: t.name, x: p.x, z: p.z, yaw: 0, zone: zoneId['Oriente'], lat: t.lat, lon: t.lon, built: builtFromStages(stages), stages };
  });
  return { id: makeId('p'), name: 'Camán I', zones, turbines, hv };
}
