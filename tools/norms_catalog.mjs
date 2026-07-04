// ─────────────────────────────────────────────────────────────────────────────
// norms_catalog.mjs — Frente 5B · fase 5B.4 · catálogo normativo built-in
//
// El modelo canónico de ReWind NO inventa nada: implementa un marco normativo
// compartido. Este catálogo documenta las equivalencias que ese modelo usa, para
// mostrarlas en la UI (referencia «⚖ Normas») y anotar el `norma` de un ensayo.
//
//   · Vocabulario de estado  ↔  ISO 19650 (gestión de la información / CDE).
//   · Sombrilla de calidad   ↔  ISO 9001 (información documentada, liberación).
//   · Avance / hitos de pago  ↔  ISO 21500 / 21502 (dirección de proyectos).
//   · Ensayos de laboratorio  ↔  NCh ≈ ASTM ≈ EN (miden lo mismo → `norma` es un
//     atributo del ensayo, no un modelo distinto).
//
// JS puro, sin dependencias. Node + navegador. Datos, no lógica.
// ─────────────────────────────────────────────────────────────────────────────

// Marco general: qué norma cubre cada capa del módulo de calidad.
export const FRAMEWORK = [
  { area: 'Sistema de gestión de calidad', norma: 'ISO 9001', detalle: 'Información documentada (7.5); control de producción y liberación (8.5/8.6); salidas no conformes (8.7).' },
  { area: 'Gestión de la información / CDE', norma: 'ISO 19650', detalle: 'Ciclos de revisión y aprobación (transmittals), estados de idoneidad, entorno común de datos.' },
  { area: 'Dirección de proyecto / hitos', norma: 'ISO 21500 · 21502', detalle: 'WBS (partidas/hitos), hitos de pago, medición de avance.' },
];

// Vocabulario de estado controlado ↔ ISO 19650 + literales observados en obra.
export const STATUS_NORMS = [
  { canon: 'aprobado', iso: 'Autorizado / sin observaciones', literals: ['Sin Comentarios', 'Enviado - OK'] },
  { canon: 'conComentarios', iso: 'Aprobado con comentarios (revisar y reenviar)', literals: ['Con comentarios', 'Enviado - Con comentarios'] },
  { canon: 'enRevision', iso: 'En revisión (WIP / compartido)', literals: ['Revisión ITO', 'Revisión QAQC'] },
  { canon: 'rechazado', iso: 'Rechazado (no autorizado)', literals: ['Rechazado'] },
  { canon: 'nulo', iso: 'Fuera de flujo', literals: ['Nulo'] },
  { canon: 'informativo', iso: 'Sólo información', literals: ['Informativo'] },
];

// Ensayos de laboratorio ↔ NCh ≈ ASTM ≈ EN (equivalencias habituales en obra civil;
// verificar la edición vigente por contrato). `match` = palabras clave para inferir
// la norma desde un texto de ensayo/grado.
export const ENSAYO_NORMS = [
  { tipo: 'Compresión de probetas', param: "Resistencia f'c (3/7/14/28/56 d)", nch: 'NCh1037', astm: 'ASTM C39', en: 'EN 12390-3', match: ['compres', 'probeta', 'hormigon', 'concrete', 'h-', 'g-', 'fc', "f'c"] },
  { tipo: 'Muestreo y curado', param: 'Confección y curado de probetas', nch: 'NCh1017', astm: 'ASTM C31', en: 'EN 12390-2', match: ['muestreo', 'curado', 'confeccion'] },
  { tipo: 'Asentamiento de cono', param: 'Slump / trabajabilidad', nch: 'NCh1019', astm: 'ASTM C143', en: 'EN 12350-2', match: ['asentamiento', 'cono', 'slump', 'docilidad'] },
  { tipo: 'Granulometría de áridos', param: 'Distribución de tamaños', nch: 'NCh165', astm: 'ASTM C136', en: 'EN 933-1', match: ['granulometr', 'arido', 'aggregate', 'tamiz'] },
  { tipo: 'Compactación (Proctor)', param: 'Densidad seca máx. / humedad óptima', nch: 'NCh1534', astm: 'ASTM D1557', en: 'EN 13286-2', match: ['proctor', 'compactac', 'densidad seca'] },
  { tipo: 'Densidad in situ (cono de arena)', param: 'Grado de compactación', nch: 'NCh1516', astm: 'ASTM D1556', en: '—', match: ['cono de arena', 'densidad in situ', 'in situ', 'terreno'] },
];

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Infiere la entrada de ensayo desde un texto libre (tipo/grado/descripción).
// Por defecto → compresión de probetas (el ensayo dominante en fundaciones).
export function normForEnsayo(text) {
  const n = norm(text);
  if (n) for (const e of ENSAYO_NORMS) if (e.match.some((k) => n.includes(k))) return e;
  return ENSAYO_NORMS[0];
}

// Etiqueta corta «NCh ≈ ASTM ≈ EN» de un ensayo (para chips en la UI).
export function normLabel(entry) {
  return [entry.nch, entry.astm, entry.en].filter((x) => x && x !== '—').join(' ≈ ');
}

// ── CLI de verificación ────────────────────────────────────────────────────────
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  console.log('── Marco normativo ──');
  for (const f of FRAMEWORK) console.log(`  ${f.norma.padEnd(18)} ${f.area}`);
  console.log('\n── Ensayos (NCh ≈ ASTM ≈ EN) ──');
  for (const e of ENSAYO_NORMS) console.log(`  ${e.tipo.padEnd(32)} ${normLabel(e)}`);
  console.log('\nInferencia «Compresión H-30 probeta»:', normForEnsayo('Compresión H-30 probeta').tipo);
  console.log('Inferencia «Proctor modificado»    :', normForEnsayo('Proctor modificado').tipo);
}
