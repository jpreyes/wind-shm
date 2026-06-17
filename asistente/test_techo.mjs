// Test del techo de cerchas integrado en muros_madera + steel framing: equilibrio.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generarModelo } from './generador.js';
const dir = path.dirname(fileURLToPath(import.meta.url)); const raiz = path.resolve(dir, '..');
const parseCSV = (t) => { const L = t.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')); const h = L[0].split(',').map(s => s.trim()); return L.slice(1).map(l => { const c = l.split(',').map(s => s.trim()); return Object.fromEntries(h.map((k, i) => [k, c[i]])); }); };
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const reglas = JSON.parse(read('reglas.json')); const materiales = parseCSV(read('materiales.csv'));
let fail = 0; const ok = (c, m) => { console.log(`${c ? '  ok ' : ' FAIL'}  ${m}`); if (!c) fail++; };

const casa = { modo: '3D', tipologia: 'muros_madera', secciones: { material: 'Pino Radiata' },
  geometria: { planta_inferior: { Lx_m: 8, Ly_m: 6 }, niveles: [{ altura_m: 3 }, { altura_m: 3 }] },
  tabiques: { escuadria: '2x4', separacion_m: 0.6 }, entrepisos: { escuadria: '2x8', separacion_m: 0.6, dir: 'X' },
  techo: { tipo: 'cercha', pendiente_pct: 10, separacion_m: 0.8, escuadria_cordon: '2x6', escuadria_diagonal: '2x4' } };
const m0 = generarModelo(casa, { reglas, materiales });
console.log('  ', m0._generado.resumen);
ok(m0.sections.length === 4, 'secciones = 4 (pie derecho, vigueta, cordón, diagonal techo)');
ok(m0.elements.length > 0, `${m0.elements.length} elementos`);

// preparar solver
globalThis.window = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(raiz, 'lib', 'numeric.js'), 'utf8'));
const tmp = path.join(dir, '_techo_tmp'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
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
  let W = 0; for (const ld of lc.loads) W += ld.w * elemL.get(ld.elemId);  // vertical (dist gravity sobre miembros, proyección vertical = w·L para gravity)
  const res = new StaticSolver().solve(m, lc.id, false);
  let Rz = 0; for (const nd of m.nodes.values()) { const r = res.getReaction(nd.id); if (r) Rz += r[2]; }
  return { W, Rz, finite: Number.isFinite(Rz) };
}

console.log('── Equilibrio CV (casa con techo de cerchas) ──');
const eq = equilibrio(m0, 'CV');
ok(eq.finite, `solución finita (no singular): ΣRz=${eq.Rz.toFixed(2)} kN`);
// Nota: en cerchas inclinadas Σ(w·L) NO es la vertical total (w es por largo inclinado en dir gravity → vertical = w·L).
ok(Math.abs(eq.Rz - eq.W) / Math.abs(eq.W) < 1e-3, `ΣRz = Σ(w·L) aplicada (${eq.Rz.toFixed(2)} vs ${eq.W.toFixed(2)} kN)`);

console.log('── Steel framing (material acero) ──');
const steel = { modo: '3D', tipologia: 'steel_framing', secciones: { material: 'acero' },
  geometria: { planta_inferior: { Lx_m: 6, Ly_m: 4 }, niveles: [{ altura_m: 2.6 }] },
  tabiques: { escuadria: '2x4', separacion_m: 0.6 }, entrepisos: { escuadria: '2x6', separacion_m: 0.6, dir: 'X' } };
const ms = generarModelo(steel, { reglas, materiales });
ok(/S\d{3}|acero/i.test(ms.materials[0].name), `material acero (${ms.materials[0].name})`);
const eqs = equilibrio(ms, 'CV');
ok(eqs.finite && Math.abs(eqs.Rz - eqs.W) / Math.abs(eqs.W) < 1e-3, `equilibrio steel: ΣRz=${eqs.Rz.toFixed(2)} vs ${eqs.W.toFixed(2)} kN`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? '\n✅ TECHO+STEEL: OK' : `\n❌ ${fail} FALLARON`);
process.exit(fail === 0 ? 0 : 1);
