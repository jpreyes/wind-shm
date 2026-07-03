// ─────────────────────────────────────────────────────────────────────────────
// test_sacyr_derived.mjs — verificación de los derivados (Frente 5, fase 5.3).
//
// Valida (a) integridad de partición de los agregados, (b) que nuestra lectura de
// ciclos REPRODUCE las fórmulas del archivo — columna O «Ciclo Documento» y P
// «Estado Documento» —, y (c) spot-checks de conteos contra el SPEC.
// El archivo real es confidencial: si no está, se SALTA con código 0.
//   node tools/test_sacyr_derived.mjs [ruta.xlsx]
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import { readSacyr } from './sacyr_reader.mjs';
import { computeDerived } from './sacyr_derived.mjs';

const CANDIDATES = [
  process.argv[2], process.env.SACYR_XLSX,
  'C:/Users/jprey/Downloads/Log protocolos SACYR.xlsx',
  `${process.env.USERPROFILE || process.env.HOME || ''}/Downloads/Log protocolos SACYR.xlsx`,
].filter(Boolean);
const path = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!path) { console.log('⚠  test_sacyr_derived: archivo real no encontrado — SALTADO.'); process.exit(0); }

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓', m); else { console.log('  ✗', m); fails++; } };
const eq = (a, b, m) => ok(a === b, `${m}  (esperado ${b}, obtuve ${a})`);

const data = await readSacyr(new Uint8Array(fs.readFileSync(path)));
const d = computeDerived(data);
console.log('archivo:', path, '\n');

// ── 1. Integridad de partición ───────────────────────────────────────────────
console.log('1. Partición de los agregados:');
const t = d.totales;
eq(t.aprobado + t.conComentarios + t.enRevision + t.nulo + t.informativo + t.rechazado + t.otro, t.total, 'suma por estado == total');
eq(t.total, data.protocolos.length, 'total == nº de protocolos');
const sumArea = Object.values(d.porArea).reduce((s, v) => s + v.total, 0);
eq(sumArea, t.total, 'suma por área == total (todo protocolo tiene área)');

// ── 2. Reproducción de las fórmulas O y P del archivo ────────────────────────
console.log('2. Reproducción de columnas O (Ciclo Documento) y P (Estado Documento):');
const ORD = { '1er': 1, '2da': 2, '3ero': 3, '4to': 4, '5to': 5 };
let badO = 0, badP = 0;
for (const p of data.protocolos) {
  const expLen = p.cicloDocumento == null ? 0 : (ORD[String(p.cicloDocumento).trim()] ?? -1);
  if (p.ciclos.length !== expLen) badO++;
  const last = p.ciclos.length ? p.ciclos[p.ciclos.length - 1].estadoRaw : null;
  if ((p.estadoActualRaw || null) !== (last || null)) badP++;
}
eq(badO, 0, 'ciclos.length == «Ciclo Documento» (O) para todo protocolo');
eq(badP, 0, 'estadoActualRaw == estado del último ciclo (P) para todo protocolo');

// ── 3. Turnaround (días hábiles recalculados == archivo, agregado) ───────────
console.log('3. Turnaround:');
let comparables = 0, match = 0;
for (const p of data.protocolos) for (const c of p.ciclos) {
  if (typeof c.diasHabiles === 'number' && typeof c.diasHabilesCalc === 'number') {
    comparables++; if (c.diasHabiles === c.diasHabilesCalc) match++;
  }
}
eq(match, comparables, `días hábiles recalculados == archivo (${comparables} ciclos)`);
ok(d.turnaround.ciclos === 1949, `nº de ciclos (${d.turnaround.ciclos})`);
ok(d.turnaround.diasHabiles.avg > 0 && d.turnaround.diasHabiles.max >= d.turnaround.diasHabiles.p90, 'estadística de días hábiles coherente');

// ── 4. Spot-checks contra el SPEC ────────────────────────────────────────────
console.log('4. Spot-checks (== SPEC / col P):');
eq(t.aprobado, 1256, 'aprobado');
eq(t.conComentarios, 87, 'conComentarios');
eq(d.pendientes.length, 87, 'pendientes == conComentarios (no cerrados)');
eq(d.porArea['Fundación'].total, 776, 'Fundación total');
eq(d.porArea['LAT'].total, 129, 'LAT total');
eq(d.ensayosHormigon.porGrado['G-40'], 323, 'ensayos hormigón G-40');

console.log(`\n${fails === 0 ? '✅ TODO OK' : `❌ ${fails} fallo(s)`}`);
process.exit(fails === 0 ? 0 : 1);
