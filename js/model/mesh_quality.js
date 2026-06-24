// ──────────────────────────────────────────────────────────────────────────────
// mesh_quality.js — CALIDAD de malla y SUAVIZADO · #52 (Fase 2)
//
// Métricas de calidad por elemento (triángulo y cuadrilátero), estadística global de
// la malla (peores celdas + histograma) y SUAVIZADO Laplaciano restringido (mueve
// los nodos interiores sin invertir elementos).  Trabaja sobre listas genéricas
// nodes=[[x,y,z]…] y cells=[[i,j,k]|[i,j,k,l]…], así sirve para mallas estructuradas
// (mesh_map) y libres (mesh_free).  AUTÓNOMO → verificable en Node.
// ──────────────────────────────────────────────────────────────────────────────
import { quadMinScaledJacobian } from './mesh_map.js?v=193';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const DEG = 180 / Math.PI;

// Ángulo interior (grados) en el vértice b del triángulo a-b-c.
function angleAt(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const lu = norm(u), lv = norm(v);
  if (lu < 1e-15 || lv < 1e-15) return 0;
  let cosT = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
  cosT = Math.min(1, Math.max(-1, cosT));
  return Math.acos(cosT) * DEG;
}

// Calidad de un triángulo: área, ángulos y forma normalizada
//   q = 4√3·A / (a²+b²+c²)  ∈ (0,1]  (1 = equilátero, →0 = degenerado).
export function triQuality(p0, p1, p2) {
  const a = norm(sub(p1, p0)), b = norm(sub(p2, p1)), c = norm(sub(p0, p2));
  const area = 0.5 * norm(cross(sub(p1, p0), sub(p2, p0)));
  const ang = [angleAt(p2, p0, p1), angleAt(p0, p1, p2), angleAt(p1, p2, p0)];
  const sumSq = a * a + b * b + c * c;
  const quality = sumSq > 1e-30 ? 4 * Math.sqrt(3) * area / sumSq : 0;
  return { area, minAngle: Math.min(...ang), maxAngle: Math.max(...ang), quality };
}

// Calidad de un cuadrilátero: área, Jacobiano escalado mínimo (forma), ángulos,
// relación de aspecto (lado mayor/menor) y alabeo (grados entre las dos mitades).
export function quadQuality(p0, p1, p2, p3) {
  const P = [p0, p1, p2, p3];
  const e = [norm(sub(p1, p0)), norm(sub(p2, p1)), norm(sub(p3, p2)), norm(sub(p0, p3))];
  const ang = [angleAt(p3, p0, p1), angleAt(p0, p1, p2), angleAt(p1, p2, p3), angleAt(p2, p3, p0)];
  // área por dos triángulos
  const area = 0.5 * (norm(cross(sub(p1, p0), sub(p2, p0))) + norm(cross(sub(p2, p0), sub(p3, p0))));
  // alabeo: ángulo entre normales de (0,1,2) y (0,2,3)
  const n1 = cross(sub(p1, p0), sub(p2, p0)), n2 = cross(sub(p2, p0), sub(p3, p0));
  const l1 = norm(n1), l2 = norm(n2);
  let warp = 0;
  if (l1 > 1e-15 && l2 > 1e-15) {
    let cosW = (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / (l1 * l2);
    warp = Math.acos(Math.min(1, Math.max(-1, cosW))) * DEG;
  }
  return {
    area, minScaledJac: quadMinScaledJacobian(...P),
    minAngle: Math.min(...ang), maxAngle: Math.max(...ang),
    aspect: Math.max(...e) / Math.max(Math.min(...e), 1e-30), warp,
  };
}

// Estadística global de una malla. cells = arreglo de [i,j,k] o [i,j,k,l].
// Devuelve mínimos/máximos, peor celda, conteos y un histograma de calidad (0..1).
export function meshStats(nodes, cells) {
  let minQ = Infinity, minJac = Infinity, minAng = Infinity, maxAng = -Infinity, maxAspect = 0, maxWarp = 0;
  let nTri = 0, nQuad = 0, worst = null;
  const hist = [0, 0, 0, 0, 0];   // [0-0.2,0.2-0.4,0.4-0.6,0.6-0.8,0.8-1]
  for (let ci = 0; ci < cells.length; ci++) {
    const c = cells[ci];
    if (c.length === 3) {
      nTri++;
      const q = triQuality(nodes[c[0]], nodes[c[1]], nodes[c[2]]);
      minAng = Math.min(minAng, q.minAngle); maxAng = Math.max(maxAng, q.maxAngle);
      hist[Math.min(4, Math.floor(q.quality * 5))]++;
      if (q.quality < minQ) { minQ = q.quality; worst = { cell: ci, type: 'tri', ...q }; }
    } else {
      nQuad++;
      const q = quadQuality(nodes[c[0]], nodes[c[1]], nodes[c[2]], nodes[c[3]]);
      minJac = Math.min(minJac, q.minScaledJac); minAng = Math.min(minAng, q.minAngle); maxAng = Math.max(maxAng, q.maxAngle);
      maxAspect = Math.max(maxAspect, q.aspect); maxWarp = Math.max(maxWarp, q.warp);
      const qn = Math.max(0, q.minScaledJac);
      hist[Math.min(4, Math.floor(qn * 5))]++;
      if (q.minScaledJac < minQ) { minQ = q.minScaledJac; worst = { cell: ci, type: 'quad', ...q }; }
    }
  }
  return { nTri, nQuad, n: cells.length, minQuality: minQ, minScaledJac: minJac, minAngle: minAng, maxAngle: maxAng, maxAspect, maxWarp, inverted: (minJac <= 0 || minAng <= 0), worst, hist };
}

// ── Adyacencia y bordes ─────────────────────────────────────────────────────────
// Aristas de una celda (pares de índices locales en orden del polígono).
function cellEdges(c) {
  const out = [];
  for (let i = 0; i < c.length; i++) out.push([c[i], c[(i + 1) % c.length]]);
  return out;
}

// Nodos de BORDE = extremos de aristas que pertenecen a una sola celda.
export function boundaryNodes(nodes, cells) {
  const count = new Map();
  const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  for (const c of cells) for (const [a, b] of cellEdges(c)) { const k = key(a, b); count.set(k, (count.get(k) || 0) + 1); }
  const bnd = new Set();
  for (const [k, n] of count) if (n === 1) { const [a, b] = k.split(',').map(Number); bnd.add(a); bnd.add(b); }
  return bnd;
}

// Vecinos de cada nodo (a través de aristas de celda).
function nodeNeighbors(nodes, cells) {
  const nb = Array.from({ length: nodes.length }, () => new Set());
  for (const c of cells) for (const [a, b] of cellEdges(c)) { nb[a].add(b); nb[b].add(a); }
  return nb.map(s => [...s]);
}

// Comprueba que ninguna celda incidente a `ni` quede invertida si el nodo se mueve a `p`.
function moveKeepsValid(nodes, cells, incident, ni, p) {
  const old = nodes[ni]; nodes[ni] = p;
  let ok = true;
  for (const ci of incident) {
    const c = cells[ci];
    const q = c.length === 3 ? triQuality(nodes[c[0]], nodes[c[1]], nodes[c[2]]).area
                             : quadMinScaledJacobian(nodes[c[0]], nodes[c[1]], nodes[c[2]], nodes[c[3]]);
    if (!(q > 1e-12)) { ok = false; break; }
  }
  nodes[ni] = old;
  return ok;
}

// Calidad NORMALIZADA de una celda (0 = degenerada/invertida, 1 = ideal):
// triángulo → 4√3·A/Σℓ² (1 = equilátero); cuadrilátero → Jacobiano escalado mínimo.
function cellQuality(nodes, c) {
  return c.length === 3
    ? triQuality(nodes[c[0]], nodes[c[1]], nodes[c[2]]).quality
    : quadMinScaledJacobian(nodes[c[0]], nodes[c[1]], nodes[c[2]], nodes[c[3]]);
}

// Calidad mínima entre las celdas incidentes al nodo `ni` (con el nodo en su pos. actual).
function incidentMinQuality(nodes, cells, incident, ni) {
  let q = Infinity;
  for (const ci of incident) { const v = cellQuality(nodes, cells[ci]); if (v < q) q = v; }
  return q;
}

/**
 * Suavizado Laplaciano RESTRINGIDO de los nodos interiores.  Mueve cada nodo
 * interior hacia el centroide de sus vecinos (factor ω).  En modo «smart» (def.)
 * el paso sólo se acepta si NO reduce la calidad mínima de las celdas incidentes
 * (con búsqueda de paso amortiguado ω → ω/2 → ω/4); así la calidad mínima de la
 * malla es monótona no-decreciente.  Los nodos de borde quedan fijos.
 * @param {Array} nodes  [[x,y,z]…]  (se devuelve una COPIA suavizada)
 * @param {Array} cells  [[i,j,k]|[i,j,k,l]…]
 * @param {object} opts  { iters=5, omega=0.5, fixed=Set|bool[], smart=true }
 * @returns { nodes, before, after, moved }
 */
export function laplacianSmooth(nodes, cells, opts = {}) {
  const iters = opts.iters ?? 5, omega = opts.omega ?? 0.5;
  const smart = opts.smart ?? true;
  const out = nodes.map(p => [p[0], p[1], p[2]]);
  const nb = nodeNeighbors(out, cells);
  const incident = Array.from({ length: out.length }, () => []);
  cells.forEach((c, ci) => c.forEach(n => incident[n].push(ci)));
  let fixed = opts.fixed;
  if (!fixed) { const b = boundaryNodes(out, cells); fixed = i => b.has(i); }
  else if (fixed instanceof Set) { const s = fixed; fixed = i => s.has(i); }
  else if (Array.isArray(fixed)) { const a = fixed; fixed = i => !!a[i]; }
  const before = meshStats(out, cells);
  let moved = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < out.length; i++) {
      if (fixed(i) || nb[i].length === 0) continue;
      let cx = 0, cy = 0, cz = 0;
      for (const j of nb[i]) { cx += out[j][0]; cy += out[j][1]; cz += out[j][2]; }
      const k = nb[i].length;
      const dir = [cx / k - out[i][0], cy / k - out[i][1], cz / k - out[i][2]];
      if (!smart) {
        const target = [out[i][0] + omega * dir[0], out[i][1] + omega * dir[1], out[i][2] + omega * dir[2]];
        if (moveKeepsValid(out, cells, incident[i], i, target)) { out[i] = target; if (it === 0) moved++; }
        continue;
      }
      // Smart: aceptar el paso (amortiguado) sólo si mejora la calidad mínima local.
      const q0 = incidentMinQuality(out, cells, incident[i], i);
      const old = out[i]; let accepted = false;
      for (let w = omega; w >= omega / 4 - 1e-9; w *= 0.5) {
        const target = [old[0] + w * dir[0], old[1] + w * dir[1], old[2] + w * dir[2]];
        if (!moveKeepsValid(out, cells, incident[i], i, target)) continue;
        out[i] = target;
        if (incidentMinQuality(out, cells, incident[i], i) >= q0 - 1e-12) { accepted = true; break; }
        out[i] = old;
      }
      if (accepted && it === 0) moved++;
    }
  }
  return { nodes: out, before, after: meshStats(out, cells), moved };
}

// Aplica el suavizado a un subconjunto de áreas del modelo (in situ).  Reconstruye
// nodes/cells desde el modelo, suaviza y reescribe las coordenadas de los nodos
// interiores no fijos.  fixedExtra = Set de nodeId adicionales a fijar (p.ej. con
// apoyos/cargas/diafragma).  Devuelve el reporte de meshStats antes/después.
export function smoothAreasInModel(model, areaIds, opts = {}) {
  const ids = areaIds && areaIds.length ? areaIds : [...model.areas.keys()];
  const nodeIdList = []; const idxOf = new Map();
  const add = (nid) => { if (!idxOf.has(nid)) { idxOf.set(nid, nodeIdList.length); nodeIdList.push(nid); } };
  for (const aid of ids) { const a = model.areas.get(aid); if (a) a.nodes.forEach(add); }
  const nodes = nodeIdList.map(id => { const n = model.nodes.get(id); return [n.x, n.y, n.z]; });
  const cells = ids.map(aid => model.areas.get(aid)).filter(Boolean).map(a => a.nodes.map(n => idxOf.get(n)));
  // Fijar nodos con apoyos, cargas nodales, masa, diafragma o pertenecientes a barras.
  const extra = new Set(opts.fixedNodeIds || []);
  for (const n of model.nodes.values()) if (n.restraints && Object.values(n.restraints).some(v => v)) extra.add(n.id);
  for (const el of model.elements.values()) { extra.add(el.n1); extra.add(el.n2); }
  const fixedArr = nodeIdList.map(id => extra.has(id));
  const res = laplacianSmooth(nodes, cells, { ...opts, fixed: fixedArr });
  res.nodes.forEach((p, i) => model.updateNode(nodeIdList[i], { x: p[0], y: p[1], z: p[2] }));
  return { before: res.before, after: res.after };
}
