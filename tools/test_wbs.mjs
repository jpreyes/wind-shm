// test_wbs.mjs — verifica el motor WBS (mapeo protocolo→partida + roll-up).
//   node tools/test_wbs.mjs
import { defaultWbs, partidaForProtocol, wbsProgress, wbsProgressByStructure } from './wbs.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  ✗', msg); fail++; } else console.log('  ✓', msg); };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

const wbs = defaultWbs('turbine');

console.log('1) mapeo protocolo→partida por área');
ok(partidaForProtocol({ id: '1', area: 'Fundación' }, wbs) === 'fundacion', 'área «Fundación» → partida fundacion');
ok(partidaForProtocol({ id: '2', area: 'Góndola' }, wbs) === 'gondola', 'área «Góndola» → partida gondola');
ok(partidaForProtocol({ id: '3', area: 'Zona rara' }, wbs) === null, 'área desconocida → null (sin asignar)');
ok(partidaForProtocol({ id: '4', area: 'X', hitoPago: 'Montaje de fuste' }, wbs) === 'fuste', 'hito de pago «Montaje de fuste» → fuste');

console.log('2) override manual gana sobre la regla');
ok(partidaForProtocol({ id: '5', area: 'Fundación' }, wbs, { 5: 'rotor' }) === 'rotor', 'override 5→rotor gana a la regla (fundación)');

console.log('3) roll-up: solo fundación con datos (caso SACYR)');
const protos = [
  { id: 'a', estructuraId: 'T01', area: 'Fundación', estadoActual: 'aprobado' },
  { id: 'b', estructuraId: 'T01', area: 'Fundación', estadoActual: 'aprobado' },
  { id: 'c', estructuraId: 'T01', area: 'Fundación', estadoActual: 'conComentarios' },
];
const r = wbsProgress(protos, wbs);
ok(near(r.porPartida.fundacion.pct, 2 / 3), 'fundación = 2/3 aprobados (66.7%)');
ok(r.porPartida.fuste.pct === 0 && r.porPartida.gondola.pct === 0, 'partidas sin protocolos = 0%');
ok(near(r.torrePct, (2 / 3) / 5), `torre = (2/3)/5 = ${(r.torrePct * 100).toFixed(1)}% (NO 66.7%)`);
ok(r.pctOrdenado.length === 5 && near(r.pctOrdenado[0], 2 / 3) && r.pctOrdenado[1] === 0, 'pctOrdenado alineado al WBS [fund, 0, 0, 0, 0]');

console.log('4) 100% de una sola partida → torre ≈ 1/5');
const full = [{ id: 'x', estructuraId: 'T02', area: 'Fundación', estadoActual: 'aprobado' }];
ok(near(wbsProgress(full, wbs).torrePct, 1 / 5), 'fundación 100% → torre 20%');

console.log('5) por estructura');
const bs = wbsProgressByStructure([...protos, ...full], { typeOf: () => 'turbine', wbsFor: () => wbs });
ok(!!bs.T01 && !!bs.T02, 'agrupa T01 y T02');
ok(near(bs.T01.porPartida.fundacion.pct, 2 / 3), 'T01 fundación 2/3');
ok(near(bs.T02.torrePct, 1 / 5), 'T02 torre 20%');

console.log(fail ? `\n✗ ${fail} fallo(s)` : '\n✓ todo OK');
if (fail) process.exit(1);
