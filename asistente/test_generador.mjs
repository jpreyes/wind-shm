// Test del generador en Node: ficha → modelo .s3d → solver estático real.
// Verifica conteos, mapeo de secciones y EQUILIBRIO global (ΣReacciones = ΣCargas).
// Uso: node asistente/test_generador.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generarModelo } from './generador.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(dir, '..');

// ── CSV mínimo (sin comillas internas en estas bibliotecas) ──────────────────
function parseCSV(txt) {
  const lines = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',').map((s) => s.trim());
    return Object.fromEntries(head.map((h, i) => [h, c[i]]));
  });
}
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

const reglas = JSON.parse(read('reglas.json'));
const perfiles = parseCSV(read('perfiles.csv'));
const materiales = parseCSV(read('materiales.csv'));
const sobrecargas = parseCSV(read('sobrecargas_NCh1537.csv'));
const ficha = JSON.parse(read('ejemplo_ficha.json'));

const modelo = generarModelo(ficha, { reglas, perfiles, materiales, sobrecargas });

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok ' : ' FAIL'}  ${msg}`); if (!cond) fail++; };

console.log('── Conteos ──');
console.log('  ', modelo._generado.resumen);
// 3 niveles + base = 4; ejes 10/6→2 vanos→3 ejes en X e Y → 9 nodos/nivel × 4 = 36
ok(modelo.nodes.length === 36, `nodos = 36 (es ${modelo.nodes.length})`);
ok(modelo.mode === '3D', 'modo 3D');
ok(modelo.materials.length === 1 && modelo.sections.length === 2, 'materiales=1, secciones=2');
ok(modelo.diaphragms.length === 3, `diafragmas = 3 (es ${modelo.diaphragms.length})`);
ok(modelo.loadCases.some((l) => l.name === 'Sismo X' && l.type === 'spectrum'), 'caso espectral Sismo X');

console.log('── Mapeo de sección IPE300 (vigas) ──');
const v = modelo.sections.find((s) => s.name === 'IPE300');
// Iz (fuerte) ← Iy_EN=8356 cm⁴ = 8.356e-5 m⁴ ; Iy (débil) ← 603.8 cm⁴ = 6.038e-6
ok(Math.abs(v.Iz - 8.356e-5) < 1e-10, `Iz fuerte = 8.356e-5 (es ${v.Iz})`);
ok(Math.abs(v.Iy - 6.038e-6) < 1e-12, `Iy débil = 6.038e-6 (es ${v.Iy})`);
ok(Math.abs(v.Avy - 25.68e-4) < 1e-9, `Avy alma = 25.68e-4 (es ${v.Avy})`);
ok(Math.abs(v.A - 53.81e-4) < 1e-9, `A = 53.81e-4 (es ${v.A})`);

console.log('── Reparto de carga de área (conserva la resultante) ──');
const lcCV = modelo.loadCases.find((l) => l.name === 'CV');
const qCV = parseFloat(sobrecargas.find((s) => s.tipo_edificio === 'Escuelas' && s.descripcion === 'Salas de Clases').Lo_kNm2);
// Σ（w·Lx_tramo) por nivel debe ≈ qCV · área del nivel
const elemL = new Map(modelo.elements.map((e) => {
  const n1 = modelo.nodes[e.n1 - 1], n2 = modelo.nodes[e.n2 - 1];
  return [e.id, Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z)];
}));
let WcvTot = 0;
for (const ld of lcCV.loads) WcvTot += ld.w * elemL.get(ld.elemId);
// área total de pisos (con planta variable)
let areaTot = 0;
for (let k = 1; k <= 3; k++) {
  const t = (k - 1) / 2; const Ly = 10 + t * (8 - 10);
  areaTot += 10 * Ly;
}
ok(Math.abs(WcvTot - qCV * areaTot) / (qCV * areaTot) < 1e-6, `ΣCV = qCV·área (${WcvTot.toFixed(2)} vs ${(qCV*areaTot).toFixed(2)} kN)`);

console.log('── Solver estático real: equilibrio (combo 1.2CM+1.6CV) ──');
// Cargar numeric.js y los módulos del solver con shim (igual que tests previos).
globalThis.window = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(raiz, 'lib', 'numeric.js'), 'utf8'));
ok(!!globalThis.numeric, 'numeric.js cargado');

// Copiar módulos del solver a temp sin "?v=" para poder importarlos.
const tmp = path.join(dir, '_gen_tmp');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
// Copia transitiva: parte de static_solver.js y sigue cada import relativo.
const buscarEn = ['js/solver', 'js/model', 'js'];
const localizar = (base) => {
  for (const d of buscarEn) { const p = path.join(raiz, d, base); if (fs.existsSync(p)) return p; }
  return null;
};
const copiados = new Set();
const copiar = (base) => {
  if (copiados.has(base)) return; copiados.add(base);
  const src0 = localizar(base); if (!src0) return;
  const src = fs.readFileSync(src0, 'utf8').replace(/\?v=\d+/g, '');
  fs.writeFileSync(path.join(tmp, base), src);
  for (const mm of src.matchAll(/from\s+['"]\.[^'"]*\/([\w.-]+\.js)['"]/g)) copiar(mm[1]);
};
copiar('static_solver.js');
copiar('model.js');
const { Model } = await import(pathToFileURL(path.join(tmp, 'model.js')).href);
const { StaticSolver } = await import(pathToFileURL(path.join(tmp, 'static_solver.js')).href);

// Reconstruir Model desde el .s3d generado (vía sus Maps).
const m = new Model();
m.materials.clear(); m.sections.clear();
m.units = modelo.units; m.mode = modelo.mode;
for (const d of modelo.materials) m.materials.set(d.id, d);
for (const d of modelo.sections) m.sections.set(d.id, d);
for (const d of modelo.nodes) m.nodes.set(d.id, d);
for (const d of modelo.elements) m.elements.set(d.id, d);
for (const d of modelo.loadCases) m.loadCases.set(d.id, d);

const res = new StaticSolver().solve(m, lcCV.id, false);
// Σ reacciones verticales (Fz) ≈ -Σ cargas verticales aplicadas (peso de CV)
let Rz = 0;
for (const n of m.nodes.values()) {
  const r = res.getReaction(n.id);
  if (r) Rz += r[2];
}
ok(Math.abs(Rz - WcvTot) / WcvTot < 1e-6, `ΣRz = ΣCV aplicada (Rz=${Rz.toFixed(2)} kN vs ${WcvTot.toFixed(2)})`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? '\n✅ TODOS LOS CHEQUEOS OK' : `\n❌ ${fail} CHEQUEO(S) FALLARON`);
process.exit(fail === 0 ? 0 : 1);
