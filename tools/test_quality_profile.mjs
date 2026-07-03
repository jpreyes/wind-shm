// test_quality_profile.mjs — verifica el import agnóstico por perfil.
//   node tools/test_quality_profile.mjs
import { writeXlsx } from '../lib/xlsx_write.mjs';
import { readXlsx } from '../lib/xlsx_lite.mjs';
import { analyzeWorkbook, proposeMapping, distinctValues, readByProfile, mapElemento, guessCanon, CANON_STATES } from './quality_profile.mjs';

let fail = 0;
const ok = (c, m) => { if (!c) { console.error('  ✗', m); fail++; } else console.log('  ✓', m); };

// Excel de un contratista FICTICIO con cabeceras/columnas distintas a SACYR.
const rows = [
  ['N° Doc', 'Aerogenerador', 'Zona de trabajo', 'Partida', 'Disciplina', 'Detalle', 'Status'],
  ['QA-001', 'WTG 03', 'Fundación', 'H1', 'Civil', 'Hormigonado zapata', 'Aprobado'],
  ['QA-002', 'WTG 03', 'Fundación', 'H1', 'Civil', 'Armadura', 'Con observaciones'],
  ['QA-003', 'WTG 12', 'Góndola', 'H3', 'Mecánica', 'Montaje nacelle', 'Aprobado'],
  ['QA-004', 'WTG 12', 'Vial', 'H0', 'Civil', 'Camino acceso', 'En revisión'],
];
const colL = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; };
const cells = [];
rows.forEach((row, ri) => row.forEach((v, ci) => { if (v != null && v !== '') cells.push({ ref: colL(ci + 1) + (ri + 1), t: 'string', v: String(v) }); }));

const bytes = writeXlsx([{ name: 'Registro QA', cells }]);
const wb = await readXlsx(bytes);

console.log('1) análisis del libro');
const sheets = analyzeWorkbook(wb);
const s = sheets.find((x) => x.name === 'Registro QA');
ok(!!s, 'detecta la hoja «Registro QA»');
ok(s.headerRow === 1, `fila de cabecera = 1 (fue ${s.headerRow})`);
ok(s.headers.length === 7, `7 cabeceras (${s.headers.length})`);

console.log('2) mapeo propuesto por sinónimos');
const map = proposeMapping(s.headers);
ok(map.elemento === 'B', `«Aerogenerador» → elemento (col ${map.elemento})`);
ok(map.area === 'C', `«Zona de trabajo» → area (col ${map.area})`);
ok(map.estado === 'G', `«Status» → estado (col ${map.estado})`);
ok(map.hitoPago === 'D', `«Partida» → hito (col ${map.hitoPago})`);
ok(map.codigoDocumento === 'A', `«N° Doc» → código (col ${map.codigoDocumento})`);

console.log('3) valores de estado distintos');
const sh = wb.sheet('Registro QA');
const vals = distinctValues(sh, 2, map.estado);
ok(vals.length === 3, `3 estados distintos: ${vals.join(', ')}`);

console.log('4) lectura por perfil → modelo canónico');
const profile = {
  name: 'Contratista Demo', sheet: 'Registro QA', headerRow: 1, dataRow: 2,
  columns: map,
  statusMap: { 'Aprobado': 'aprobado', 'Con observaciones': 'conComentarios', 'En revisión': 'enRevision' },
  element: { pattern: 'WTG\\s*0*(\\d+)', template: 'T$1' },
};
const model = readByProfile(wb, profile);
ok(model.protocolos.length === 4, `4 protocolos (${model.protocolos.length})`);
const p1 = model.protocolos[0];
ok(p1.estructuraId === 'T03', `WTG 03 → T03 (${p1.estructuraId})`);
ok(p1.area === 'Fundación' && p1.estadoActual === 'aprobado', 'primer protocolo: área+estado canónico');
ok(model.protocolos[1].estadoActual === 'conComentarios', 'estado «Con observaciones» → conComentarios');
ok(mapElemento('WTG 12', profile) === 'T12', 'mapElemento WTG 12 → T12');

console.log('5) guessCanon: siempre dentro de CANON_STATES, con heurística');
ok(guessCanon('Con observaciones') === 'conComentarios', '«Con observaciones» → conComentarios (no aprobado)');
ok(guessCanon('Aprobado') === 'aprobado', '«Aprobado» → aprobado');
ok(guessCanon('Rechazado por ITO') === 'rechazado', '«Rechazado…» → rechazado');
ok(guessCanon('Bla bla desconocido') === 'enRevision', 'desconocido → enRevision (default pendiente)');
ok(CANON_STATES.includes(guessCanon('cualquier cosa')), 'guessCanon siempre ∈ CANON_STATES');

console.log(fail ? `\n✗ ${fail} fallo(s)` : '\n✓ todo OK');
if (fail) process.exit(1);
