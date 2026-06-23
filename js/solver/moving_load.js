// ──────────────────────────────────────────────────────────────────────────────
// moving_load.js — CARGAS MÓVILES y LÍNEAS DE INFLUENCIA · #61
//
// Un tren de cargas (camión, eje de ferrocarril) recorre una «pista» (lane) sobre
// la estructura.  Para cada posición se resuelve el estático y se registra la
// respuesta de interés (reacción, momento/cortante en una sección).  El barrido da:
//   · LÍNEA DE INFLUENCIA: respuesta ante una carga UNITARIA móvil, en función de
//     la posición de la carga → R(s).  (Para una viga simple, IL de la reacción
//     izquierda = 1 − x/L; IL del momento en el centro = triángulo de pico L/4.)
//   · ENVOLVENTE: máximos y mínimos de la respuesta sobre todas las posiciones del
//     tren → diseño del tablero a tránsito.
//
// Optimización: la matriz K es CONSTANTE (la estructura no cambia); se factoriza
// UNA vez (LU) y sólo se rearma el vector de carga F por posición → barridos rápidos.
//
// Convención: la carga del tren es VERTICAL hacia abajo (−Z); su magnitud P>0.
// La carga puntual se reparte a los nodos del elemento que la contiene por funciones
// de forma de Hermite (fuerzas y momentos nodales consistentes → respuesta exacta).
// ──────────────────────────────────────────────────────────────────────────────
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from './assembler.js?v=140';
import { Results } from './postprocess.js?v=140';

const NUM = () => (typeof window !== 'undefined' && window.numeric) || (typeof globalThis !== 'undefined' && globalThis.numeric);

// ── Pista (lane): camino ordenado de elementos colineales/contiguos ─────────────
/**
 * @param {Model} model
 * @param {number[]} elemIds  elementos en orden a lo largo de la pista.
 * @returns lane = { elems, lens, L, accum }  (accum[i] = distancia al inicio del elem i)
 */
export function buildLane(model, elemIds) {
  const elems = elemIds.map(id => model.elements.get(id)).filter(Boolean);
  if (!elems.length) throw new Error('pista (lane) vacía');
  const lens = elems.map(e => {
    const a = model.nodes.get(e.n1), b = model.nodes.get(e.n2);
    return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  });
  const accum = []; let s = 0; for (const l of lens) { accum.push(s); s += l; }
  return { elems, lens, accum, L: s };
}

// Cargas de modelo (nodales consistentes) de una carga vertical P (↓, P>0) a la
// distancia x del inicio de la pista. Hermite cúbico → fuerzas + momentos nodales.
export function laneLoadAt(model, lane, x, P) {
  if (x < -1e-9 || x > lane.L + 1e-9) return [];          // fuera de la pista
  let idx = 0; while (idx < lane.elems.length - 1 && x > lane.accum[idx] + lane.lens[idx] + 1e-9) idx++;
  const el = lane.elems[idx], Le = lane.lens[idx];
  const xi = Math.min(Math.max((x - lane.accum[idx]) / Le, 0), 1);
  const N1 = 1 - 3 * xi * xi + 2 * xi ** 3, N2 = 3 * xi * xi - 2 * xi ** 3;
  const Hb1 = Le * (xi - 2 * xi * xi + xi ** 3), Hb2 = Le * (-xi * xi + xi ** 3);
  const Fz = -P;                                           // ↓
  const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
  // Momento de flexión en el plano X–Z asociado a la carga vertical → My.
  return [
    { type: 'nodal', nodeId: n1.id, F: [0, 0, Fz * N1, 0, -Fz * Hb1, 0] },
    { type: 'nodal', nodeId: n2.id, F: [0, 0, Fz * N2, 0, -Fz * Hb2, 0] },
  ];
}

// ── Solver lineal preparado (K factorizada una vez) ─────────────────────────────
function prepare(model) {
  const num = NUM(); if (!num) throw new Error('numeric.js no está disponible');
  const ni = buildNodeIndex(model);
  const nDOF = ni.size * 6;
  const { K } = assembleK(model, ni);
  const is2D = model.mode === '2D';
  const freeDOF = [], fixedDOF = [];
  const dofNames = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];
  for (const node of model.nodes.values()) {
    const d = getNodeDOFs(ni, node.id), r = node.restraints, pd = node.prescDisp;
    const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
    d.forEach((gi, li) => { (rArr[li] || (pd && (+pd[dofNames[li]] || 0) !== 0)) ? fixedDOF.push(gi) : freeDOF.push(gi); });
  }
  if (!freeDOF.length) throw new Error('modelo sin GDL libres');
  const nF = freeDOF.length;
  const Kff = Array.from({ length: nF }, (_, i) => { const row = new Array(nF), ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) row[j] = K[ri + freeDOF[j]]; return row; });
  const lu = num.LU(Kff);
  return { num, ni, nDOF, K, freeDOF, fixedDOF, lu };
}

function makeView(model, loads) {
  const lc = { id: -1, name: '_ml', loads, selfWeight: false, type: 'static', specDir: null };
  return { nodes: model.nodes, elements: model.elements, areas: model.areas, diaphragms: model.diaphragms,
           materials: model.materials, sections: model.sections, loadCases: new Map([[-1, lc]]),
           combinations: new Map(), mode: model.mode, units: model.units };
}

// Resuelve para un set de cargas dado, reusando la factorización LU.
function solveLoads(prep, model, loads) {
  const { num, ni, nDOF, K, freeDOF, fixedDOF, lu } = prep;
  const view = makeView(model, loads);
  const F = assembleF(view, ni, -1, false);
  const Ff = freeDOF.map(d => F[d]);
  const uf = num.LUsolve(lu, Ff);
  const u = new Float64Array(nDOF);
  freeDOF.forEach((d, i) => { u[d] = uf[i]; });
  const reactions = new Float64Array(nDOF);
  for (const gi of fixedDOF) { let s = 0; const ri = gi * nDOF; for (let j = 0; j < nDOF; j++) s += K[ri + j] * u[j]; reactions[gi] = s - F[gi]; }
  return new Results(view, ni, u, reactions, F, -1, false);
}

/**
 * Línea de influencia de una respuesta ante una carga unitaria móvil (↓).
 * @param {Model} model
 * @param {object} lane     buildLane(...)
 * @param {(res)=>number} response  evaluador (ver helpers responseXXX)
 * @param {object} opts     { nPos = 41, P = 1 }
 * @returns { s:[…], value:[…], max, min, sMax, sMin }
 */
export function influenceLine(model, lane, response, opts = {}) {
  const nPos = opts.nPos || 41, P = opts.P ?? 1;
  const prep = prepare(model);
  const s = [], value = [];
  let max = -Infinity, min = Infinity, sMax = 0, sMin = 0;
  for (let i = 0; i < nPos; i++) {
    const x = lane.L * i / (nPos - 1);
    const loads = laneLoadAt(model, lane, x, P);
    const v = loads.length ? response(solveLoads(prep, model, loads)) : 0;
    s.push(x); value.push(v);
    if (v > max) { max = v; sMax = x; }
    if (v < min) { min = v; sMin = x; }
  }
  return { s, value, max, min, sMax, sMin };
}

/**
 * Envolvente de una o varias respuestas ante un TREN de cargas móvil.
 * @param {Model} model
 * @param {object} lane
 * @param {Array}  train   ejes: [{ offset, P }]  (offset = distancia al eje de
 *                         referencia, m; P = carga ↓, kN)
 * @param {Object<string,(res)=>number>} responses  mapa nombre→evaluador
 * @param {object} opts    { nPos = 81, x0 = -trainLen, x1 = lane.L }
 * @returns { positions:[…], series:{name:[…]}, env:{name:{max,min,atMax,atMin}} }
 */
export function movingLoadEnvelope(model, lane, train, responses, opts = {}) {
  const prep = prepare(model);
  const offsets = train.map(t => t.offset || 0);
  const trainLen = Math.max(...offsets) - Math.min(...offsets);
  const nPos = opts.nPos || 81;
  const x0 = opts.x0 ?? -Math.min(...offsets);
  const x1 = opts.x1 ?? (lane.L - Math.max(...offsets));
  const names = Object.keys(responses);
  const series = {}; names.forEach(n => series[n] = []);
  const env = {}; names.forEach(n => env[n] = { max: -Infinity, min: Infinity, atMax: 0, atMin: 0 });
  const positions = [];

  for (let i = 0; i < nPos; i++) {
    const ref = x0 + (x1 - x0) * i / (nPos - 1);
    const loads = [];
    for (const ax of train) {
      const x = ref + (ax.offset || 0);
      if (x < -1e-9 || x > lane.L + 1e-9) continue;        // eje fuera del puente
      for (const l of laneLoadAt(model, lane, x, ax.P)) loads.push(l);
    }
    positions.push(ref);
    if (!loads.length) { names.forEach(n => series[n].push(0)); continue; }
    const res = solveLoads(prep, model, loads);
    for (const n of names) {
      const v = responses[n](res);
      series[n].push(v);
      const e = env[n];
      if (v > e.max) { e.max = v; e.atMax = ref; }
      if (v < e.min) { e.min = v; e.atMin = ref; }
    }
  }
  return { positions, series, env, trainLen };
}

// ── Evaluadores de respuesta (helpers) ──────────────────────────────────────────
const COMP = { Fx: 0, Fy: 1, Fz: 2, Mx: 3, My: 4, Mz: 5 };
// Reacción en un apoyo (componente Fx..Mz).
export const responseReaction = (nodeId, comp = 'Fz') => (res) => res.getReaction(nodeId)[COMP[comp]];
// Esfuerzo de extremo de un elemento (clave N, Vy1, Mz1, …).
export const responseElemForce = (elemId, key) => (res) => res.getElemForces(elemId)?.[key] ?? 0;
// Esfuerzo en una sección interior del elemento (xi∈[0,1]): N|Vy|Vz|T|My|Mz.
export const responseSection = (elemId, xi, key) => (res) => res.getElemAtXi(elemId, xi)?.[key] ?? 0;
// Desplazamiento nodal (componente).
export const responseDisp = (nodeId, comp = 'uz') => {
  const map = { ux: 0, uy: 1, uz: 2, rx: 3, ry: 4, rz: 5 };
  return (res) => res.getNodeDisp(nodeId)[map[comp]];
};
