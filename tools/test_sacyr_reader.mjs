// ─────────────────────────────────────────────────────────────────────────────
// test_sacyr_reader.mjs — verificación del reader SACYR (Frente 5, fase 5.1).
// Standalone Node script (patrón del repo): sin runner, es su propio entry point.
//
//   node tools/test_sacyr_reader.mjs [ruta.xlsx]
//
// El archivo real («Log protocolos SACYR.xlsx») es CONFIDENCIAL y NO se versiona:
// vive fuera del repo (Downloads / backend). Si no se encuentra, el test se SALTA
// con código 0 (no rompe CI). Con el archivo presente, valida invariantes exactos
// contra las distribuciones verbatim del anexo SPEC-sacyr-xlsx.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import { readSacyr } from './sacyr_reader.mjs';

const CANDIDATES = [
  process.argv[2], process.env.SACYR_XLSX,
  'C:/Users/jprey/Downloads/Log protocolos SACYR.xlsx',
  `${process.env.USERPROFILE || process.env.HOME || ''}/Downloads/Log protocolos SACYR.xlsx`,
].filter(Boolean);
const path = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

if (!path) {
  console.log('⚠  test_sacyr_reader: archivo real no encontrado — SALTADO.');
  console.log('   (pásalo como argumento o define SACYR_XLSX; es confidencial, fuera del repo).');
  process.exit(0);
}

let fails = 0;
function ok(cond, msg) { if (cond) console.log('  ✓', msg); else { console.log('  ✗', msg); fails++; } }
function eq(a, b, msg) { ok(a === b, `${msg}  (esperado ${b}, obtuve ${a})`); }

const d = await readSacyr(new Uint8Array(fs.readFileSync(path)));
console.log('archivo:', path, '\n');

// ── 1. Conteos maestros (regresión contra el archivo de-facto) ───────────────
console.log('1. Conteos:');
eq(d.protocolos.length, 1364, 'protocolos');
const totCiclos = d.protocolos.reduce((s, p) => s + p.ciclos.length, 0);
eq(totCiclos, 1949, 'ciclos totales');
eq(d.ensayosHormigon.length, 455, 'ensayos hormigón');

// ── 2. Distribución de estados (== columna P del SPEC: 1256/87/20/1) ─────────
console.log('2. Estados de protocolo (== col P verbatim):');
const est = {};
for (const p of d.protocolos) est[p.estadoActual] = (est[p.estadoActual] || 0) + 1;
eq(est.aprobado, 1256, 'aprobado (Sin Comentarios 886 + Sin comentarios 370)');
eq(est.conComentarios, 87, 'conComentarios');
eq(est.nulo, 20, 'nulo');
eq(est.informativo, 1, 'informativo');

// ── 3. Distribución de área (== col F del SPEC) ──────────────────────────────
console.log('3. Áreas (== col F verbatim):');
const ar = {};
for (const p of d.protocolos) ar[p.area] = (ar[p.area] || 0) + 1;
eq(ar['Fundación'], 776, 'Fundación');
eq(ar['Subestación Camán'], 305, 'Subestación Camán');
eq(ar['Subestación Huichahue'], 154, 'Subestación Huichahue');
eq(ar['LAT'], 129, 'LAT');

// ── 4. Ensayos hormigón: grado y planta (== SPEC) ────────────────────────────
console.log('4. Ensayos hormigón (grado/planta == SPEC):');
const gr = {};
for (const e of d.ensayosHormigon) gr[e.grado] = (gr[e.grado] || 0) + 1;
eq(gr['G-40'], 323, 'grado G-40');
eq(gr['G-25'], 67, 'grado G-25');
eq(gr['G-45'], 28, 'grado G-45');
const pl = {};
for (const e of d.ensayosHormigon) pl[e.planta] = (pl[e.planta] || 0) + 1;
eq(pl['Sacyr'], 402, 'planta Sacyr');

// ── 5. Días hábiles recalculados == archivo (NETWORKDAYS lun-vie − 1) ────────
console.log('5. Días hábiles recalculados vs archivo:');
let comparables = 0, match = 0;
for (const p of d.protocolos) for (const c of p.ciclos) {
  if (typeof c.diasHabiles === 'number' && typeof c.diasHabilesCalc === 'number') {
    comparables++; if (c.diasHabiles === c.diasHabilesCalc) match++;
  }
}
ok(comparables > 1800, `${comparables} ciclos comparables`);
eq(match, comparables, 'todos los días hábiles recalculados coinciden con el archivo');

// ── 6. Spot-check fila 7 (protocolo WTG 01 conocido) ─────────────────────────
console.log('6. Spot-check fila 7:');
const p7 = d.protocolos.find((p) => p._origen.fila === 7);
ok(!!p7, 'existe protocolo en fila 7');
if (p7) {
  eq(p7.area, 'Fundación', 'fila7.area');
  eq(p7.elemento, 'WTG 01', 'fila7.elemento');
  eq(p7.estructuraId, 'T01', 'fila7 → estructura ReWind T01');
  eq(p7.estadoActual, 'aprobado', 'fila7.estadoActual');
  eq(p7.ciclos.length, 2, 'fila7 nº de ciclos');
  const c1 = p7.ciclos[0];
  eq(c1.estado, 'conComentarios', 'fila7 ciclo1.estado');
  eq(c1.fechaEnvio, '2022-10-17', 'fila7 ciclo1.fechaEnvio');
  eq(c1.diasHabilesCalc, 3, 'fila7 ciclo1.diasHabilesCalc');
}

// ── 7. Cobertura raw + catálogos ─────────────────────────────────────────────
console.log('7. Cobertura raw y catálogos:');
const rawLog = d._raw['LOG PTL Parque y SSEE'];
ok(rawLog && rawLog.rows.length >= 1400, `raw LOG capturó ${rawLog ? rawLog.rows.length : 0} filas`);
ok(rawLog && rawLog.cellCount > 40000, `raw LOG capturó ${rawLog ? rawLog.cellCount : 0} celdas con dato`);
ok(d.catalogos.estados.includes('Revisión ITO Civil'), 'catálogo de estados incluye «Revisión ITO Civil»');
ok(d.catalogos.estados.includes('Revición ITO Eléctrico'), 'catálogo preserva el typo «Revición» del original');
ok(d.catalogos.areasTrabajo.includes('Fundación'), 'catálogo de áreas de trabajo incluye «Fundación»');

// ── Cobertura estructurada: cada protocolo aparece en el raw de su fila ──────
console.log('8. Consistencia modelo↔raw:');
const rawRowsByN = new Map(rawLog.rows.map((r) => [r.r, r]));
let sinRaw = 0;
for (const p of d.protocolos) if (!rawRowsByN.has(p._origen.fila)) sinRaw++;
eq(sinRaw, 0, 'todo protocolo estructurado tiene su fila en la captura raw');

console.log(`\n${fails === 0 ? '✅ TODO OK' : `❌ ${fails} fallo(s)`}`);
process.exit(fails === 0 ? 0 : 1);
