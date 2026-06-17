// Test de tipologías PUENTE y GALPÓN: generación + equilibrio con solver real.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generarModelo } from './generador.js';
const dir = path.dirname(fileURLToPath(import.meta.url)); const raiz = path.resolve(dir, '..');
const parseCSV = (t) => { const L = t.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')); const h = L[0].split(',').map(s => s.trim()); return L.slice(1).map(l => { const c = l.split(',').map(s => s.trim()); return Object.fromEntries(h.map((k, i) => [k, c[i]])); }); };
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const reglas = JSON.parse(read('reglas.json')); const materiales = parseCSV(read('materiales.csv')); const perfiles = parseCSV(read('perfiles.csv'));
let fail = 0; const ok = (c, m) => { console.log(`${c ? '  ok ' : ' FAIL'}  ${m}`); if (!c) fail++; };

globalThis.window = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(raiz, 'lib', 'numeric.js'), 'utf8'));
const tmp = path.join(dir, '_pg_tmp'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
const buscarEn = ['js/solver', 'js/model', 'js']; const localizar = (b) => { for (const d of buscarEn) { const p = path.join(raiz, d, b); if (fs.existsSync(p)) return p; } return null; };
const vis = new Set(); const copiar = (b) => { if (vis.has(b)) return; vis.add(b); const s0 = localizar(b); if (!s0) return; const s = fs.readFileSync(s0, 'utf8').replace(/\?v=\d+/g, ''); fs.writeFileSync(path.join(tmp, b), s); for (const mm of s.matchAll(/from\s+['"]\.[^'"]*\/([\w.-]+\.js)['"]/g)) copiar(mm[1]); };
copiar('static_solver.js'); copiar('model.js');
const { Model } = await import(pathToFileURL(path.join(tmp, 'model.js')).href);
const { StaticSolver } = await import(pathToFileURL(path.join(tmp, 'static_solver.js')).href);
function equilibrio(modelo, lcName) {
  const m = new Model(); m.materials.clear(); m.sections.clear(); m.units = modelo.units; m.mode = modelo.mode;
  for (const d of modelo.materials) m.materials.set(d.id, d);
  for (const d of modelo.sections) m.sections.set(d.id, d);
  for (const d of modelo.nodes) m.nodes.set(d.id, d);
  for (const d of modelo.elements) m.elements.set(d.id, d);
  for (const d of modelo.loadCases) m.loadCases.set(d.id, d);
  const lc = modelo.loadCases.find(l => l.name === lcName);
  const elemL = new Map(modelo.elements.map(e => { const a = modelo.nodes[e.n1 - 1], b = modelo.nodes[e.n2 - 1]; return [e.id, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)]; }));
  let W = 0; for (const ld of lc.loads) W += ld.w * elemL.get(ld.elemId);
  const res = new StaticSolver().solve(m, lc.id, false);
  let Rz = 0; for (const nd of m.nodes.values()) { const r = res.getReaction(nd.id); if (r) Rz += r[2]; }
  return { W, Rz, finite: Number.isFinite(Rz) };
}

console.log('── PUENTE (viga continua) ──');
const pv = generarModelo({ modo: '3D', tipologia: 'puente', secciones: { material: 'H30' }, puente: { largo_m: 100, ancho_m: 2, luz_pila_m: 20, altura_pila_m: 6, tipo_viga: 'viga' } }, { reglas, materiales, perfiles });
console.log('  ', pv._generado.resumen);
const eqpv = equilibrio(pv, 'CV');
ok(eqpv.finite, `solución finita: ΣRz=${eqpv.Rz.toFixed(1)} kN`);
ok(Math.abs(eqpv.Rz - eqpv.W) / Math.abs(eqpv.W) < 1e-3, `ΣRz=Σaplicada (${eqpv.Rz.toFixed(1)} vs ${eqpv.W.toFixed(1)} kN)`);
ok(Math.abs(eqpv.W - 4.0 * 2 * 100) / (4.0 * 2 * 100) < 1e-3, `CV = 4·ancho·largo = ${(4 * 2 * 100)} kN (es ${eqpv.W.toFixed(0)})`);

console.log('── PUENTE (vigas de celosía Pratt) ──');
const pc = generarModelo({ modo: '3D', tipologia: 'puente', secciones: { material: 'acero' }, puente: { largo_m: 40, ancho_m: 4, luz_pila_m: 20, altura_pila_m: 6, tipo_viga: 'cercha', tipo_celosia: 'pratt', canto_m: 2 } }, { reglas, materiales, perfiles });
console.log('  ', pc._generado.resumen);
const eqpc = equilibrio(pc, 'CV');
ok(eqpc.finite && Math.abs(eqpc.Rz - eqpc.W) / Math.abs(eqpc.W) < 1e-3, `equilibrio celosía: ΣRz=${eqpc.Rz.toFixed(1)} vs ${eqpc.W.toFixed(1)} kN`);

console.log('── GALPÓN (acero, cerchas Howe) ──');
const gp = generarModelo({ modo: '3D', tipologia: 'galpon', secciones: { material: 'acero' }, galpon: { luz_m: 20, largo_m: 30, altura_columna_m: 6, separacion_marcos_m: 5, pendiente_pct: 15, tipo_celosia: 'howe' } }, { reglas, materiales, perfiles });
console.log('  ', gp._generado.resumen);
ok(gp.materials[0].name === 'S275', `material acero (${gp.materials[0].name})`);
const eqg = equilibrio(gp, 'CV');
ok(eqg.finite, `solución finita: ΣRz=${eqg.Rz.toFixed(1)} kN`);
ok(Math.abs(eqg.Rz - eqg.W) / Math.abs(eqg.W) < 1e-3, `ΣRz=Σaplicada (${eqg.Rz.toFixed(1)} vs ${eqg.W.toFixed(1)} kN)`);
ok(Math.abs(eqg.W - 1.0 * 20 * 30) / (1.0 * 20 * 30) < 1e-3, `CV techo = 1·luz·largo = ${20 * 30} kN (es ${eqg.W.toFixed(0)})`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? '\n✅ PUENTE+GALPÓN: OK' : `\n❌ ${fail} FALLARON`);
process.exit(fail === 0 ? 0 : 1);
