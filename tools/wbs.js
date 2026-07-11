// ─────────────────────────────────────────────────────────────────────────────
// wbs.js — Frente 5 · fase A · WBS de obra (partidas / hitos) + mapeo
// protocolo→partida + roll-up de avance por estructura.
//
// Consolidación normativa (ISO 21502 · 19650 · 9001):
//   · PARTIDA (hito constructivo) = nivel-1 del WBS = entregable físico. Gobierna
//     el llenado 4D (cada partida tiene un `geom` = componente físico de la torre).
//   · SUB-PARTIDA (opcional) = agrupador (contenedor de información ISO 19650).
//   · PROTOCOLO / PPI / ITP = la hoja (el «protocolo» del contratista, punto de
//     inspección ISO 9001 §8.6) → lleva `estadoActual`.
//   · HITO DE PAGO = dimensión comercial PARALELA (valorización); NO es el árbol
//     físico — se conserva como etiqueta, no se mezcla con la partida.
//
// El avance de una partida = fracción de sus protocolos aprobados; el de la torre
// = roll-up ponderado (peso) de sus partidas. Una partida sin protocolos = 0 %
// (obra sin empezar) → resuelve el caso «solo hay protocolos de fundación».
//
// JS puro, sin dependencias. Node (tests) + navegador. Editable en el HUD (fase B).
// ─────────────────────────────────────────────────────────────────────────────

// Partidas por defecto por tipo de estructura, ALINEADAS al orden de las etapas
// 4D existentes (parks_data_caman · STAGE_NAMES) para que partida[i] ↔ etapa[i].
// `geom` = componente físico (llenado 3D); `peso` = ponderación del roll-up.
export const DEFAULT_WBS = {
  turbine: [
    { id: 'fundacion', nombre: 'Fundación',          geom: 'fundacion', peso: 1 },
    { id: 'fuste',     nombre: 'Montaje de fuste',   geom: 'fuste',     peso: 1 },
    { id: 'gondola',   nombre: 'Góndola',            geom: 'gondola',   peso: 1 },
    { id: 'rotor',     nombre: 'Rotor',              geom: 'rotor',     peso: 1 },
    { id: 'cableado',  nombre: 'Puesta en marcha',   geom: 'cableado',  peso: 1 },
  ],
  hv: [
    { id: 'fundacion',    nombre: 'Fundación',              geom: 'fundacion',    peso: 1 },
    { id: 'celosia',      nombre: 'Montaje de celosía',     geom: 'celosia',      peso: 1 },
    { id: 'conductores',  nombre: 'Tendido de conductores', geom: 'conductores',  peso: 1 },
    { id: 'energizacion', nombre: 'Energización',           geom: 'energizacion', peso: 1 },
  ],
  // Camino (estructura LINEAL): las partidas son capas del paquete estructural,
  // en orden constructivo. `geom` = capa que se «construye» a lo largo del tramo.
  camino: [
    { id: 'despeje',  nombre: 'Despeje y limpieza',     geom: 'despeje',  peso: 1 },
    { id: 'tierras',  nombre: 'Movimiento de tierras',  geom: 'tierras',  peso: 1 },
    { id: 'subbase',  nombre: 'Sub-base granular',      geom: 'subbase',  peso: 1 },
    { id: 'base',     nombre: 'Base granular',          geom: 'base',     peso: 1 },
    { id: 'carpeta',  nombre: 'Carpeta de rodado',      geom: 'carpeta',  peso: 1 },
  ],
};

// Clona la lista de partidas por defecto de un tipo (para editarla sin mutar la base).
export function defaultWbs(type = 'turbine') {
  return (DEFAULT_WBS[type] || DEFAULT_WBS.turbine).map((p) => ({ ...p }));
}

// Normaliza un literal para comparar (minúsculas, sin acentos, solo alfanumérico).
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Diccionario de sinónimos partida→literales (área de trabajo / hito). Semilla
// ES/EN; se amplía en el HUD (fase B). La clave es el `geom` (o el id) de la partida.
export const SYNONYMS = {
  fundacion:    ['fundacion', 'fundaciones', 'zapata', 'cimentacion', 'foundation', 'pedestal', 'losa'],
  fuste:        ['fuste', 'torre', 'tower', 'montaje de fuste', 'seccion', 'tramo', 'mastil'],
  gondola:      ['gondola', 'nacelle', 'nacela', 'gondola nacelle'],
  rotor:        ['rotor', 'aspas', 'palas', 'blades', 'buje', 'hub'],
  cableado:     ['cableado', 'electrico', 'colectora', 'puesta en marcha', 'commissioning', 'plataforma', 'vial'],
  celosia:      ['celosia', 'estructura', 'lattice', 'montaje de celosia'],
  crucetas:     ['cruceta', 'crucetas', 'aislador', 'aisladores'],
  conductores:  ['conductor', 'conductores', 'tendido', 'cable'],
  energizacion: ['energizacion', 'puesta en tension', 'energizado'],
  despeje:      ['despeje', 'limpieza', 'roce', 'escarpe', 'destronque', 'clearing'],
  tierras:      ['movimiento de tierras', 'terraplen', 'corte', 'relleno', 'excavacion', 'earthworks'],
  subbase:      ['sub base', 'subbase', 'sub-base', 'subrasante'],
  base:         ['base granular', 'base', 'estabilizado'],
  carpeta:      ['carpeta', 'rodado', 'sello', 'asfalto', 'imprimacion', 'capa de rodadura', 'pavimento'],
};

// Literales que hacen «match» a una partida: sus `match` explícitos (editados en el
// HUD) ∪ los sinónimos por defecto de su geom. Aditivo → los defaults siguen valiendo.
function partidaSyns(part) {
  const explicit = (part.match || []).map(norm).filter(Boolean);
  const syn = SYNONYMS[part.geom || part.id] || [norm(part.nombre)];
  return [...explicit, ...syn];
}

// ¿A qué partida (id) corresponde un protocolo?  override manual > regla por
// área/hito de pago/descripción (match ∪ sinónimos) > null (sin asignar).
export function partidaForProtocol(p, wbs, overrides = {}) {
  if (p && overrides && overrides[p.id]) return overrides[p.id];
  const hay = [p?.area, p?.hitoPago, p?.descripcion].map(norm).filter(Boolean);
  if (!hay.length) return null;
  for (const part of wbs) {
    const syns = partidaSyns(part);
    for (const h of hay) for (const s of syns) if (h === s || h.includes(s) || s.includes(h)) return part.id;
  }
  return null;
}

// Avance del WBS para un conjunto de protocolos (típicamente los de UNA estructura).
// → { porPartida: {id:{nombre,geom,peso,total,aprobado,pct,protocolos[]}},
//     pctOrdenado: [pct por partida en el orden del WBS], torrePct, sinAsignar[] }
export function wbsProgress(protocolos, wbs, overrides = {}) {
  const porPartida = {};
  for (const part of wbs) {
    porPartida[part.id] = {
      id: part.id, nombre: part.nombre, geom: part.geom, peso: part.peso ?? 1,
      total: 0, aprobado: 0, pct: 0, protocolos: [],
    };
  }
  const sinAsignar = [];
  for (const p of (protocolos || [])) {
    const pid = partidaForProtocol(p, wbs, overrides);
    const b = pid && porPartida[pid];
    if (!b) { sinAsignar.push(p.id); continue; }
    b.total++;
    if (p.estadoActual === 'aprobado') b.aprobado++;
    b.protocolos.push(p.id);
  }
  let wSum = 0, wPct = 0;
  const pctOrdenado = [];
  const geomAcc = {};   // geom → {w, wp} para promedio ponderado por peso
  for (const part of wbs) {
    const b = porPartida[part.id];
    b.pct = b.total ? +(b.aprobado / b.total).toFixed(4) : 0;
    pctOrdenado.push(b.pct);
    wSum += b.peso; wPct += b.peso * b.pct;
    if (part.geom) { const g = (geomAcc[part.geom] ??= { w: 0, wp: 0 }); g.w += b.peso; g.wp += b.peso * b.pct; }
  }
  // Avance por componente físico (geom) → gobierna el llenado 4D. Si varias partidas
  // comparten geom, se promedia ponderado por peso.
  const pctByGeom = {};
  for (const [g, a] of Object.entries(geomAcc)) pctByGeom[g] = a.w ? +(a.wp / a.w).toFixed(4) : 0;
  const torrePct = wSum ? +(wPct / wSum).toFixed(4) : 0;
  return { porPartida, pctOrdenado, pctByGeom, torrePct, sinAsignar };
}

// Agrupa los protocolos por estructura y calcula el avance WBS de cada una.
// `wbsFor(id, type)` resuelve la lista de partidas de esa estructura (permite WBS
// distinto por tipo/estructura). `typeOf(id)` da el tipo ('turbine'|'hv').
export function wbsProgressByStructure(protocolos, { wbsFor, typeOf, overrides = {} } = {}) {
  const byId = {};
  for (const p of (protocolos || [])) {
    if (!p.estructuraId) continue;
    (byId[p.estructuraId] ??= []).push(p);
  }
  const out = {};
  for (const [id, ps] of Object.entries(byId)) {
    const type = typeOf ? typeOf(id) : 'turbine';
    const wbs = wbsFor ? wbsFor(id, type) : defaultWbs(type);
    out[id] = wbsProgress(ps, wbs, overrides);
  }
  return out;
}

// ── CLI de verificación rápida ────────────────────────────────────────────────
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const wbs = defaultWbs('turbine');
  const protos = [
    { id: 'a', area: 'Fundación', estadoActual: 'aprobado' },
    { id: 'b', area: 'Fundación', estadoActual: 'aprobado' },
    { id: 'c', area: 'Fundación', estadoActual: 'conComentarios' },
    { id: 'd', area: 'Plataforma', estadoActual: 'aprobado' },
  ];
  console.log('── WBS demo (torre, solo fundación) ──');
  const r = wbsProgress(protos, wbs);
  console.log('por partida :', Object.values(r.porPartida).map((b) => `${b.nombre}=${(b.pct * 100).toFixed(0)}% (${b.aprobado}/${b.total})`).join(' · '));
  console.log('torre       :', (r.torrePct * 100).toFixed(1) + '%');
  console.log('sin asignar :', r.sinAsignar.length);
}
