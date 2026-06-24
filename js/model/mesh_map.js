// ──────────────────────────────────────────────────────────────────────────────
// mesh_map.js — Mallado TRANSFINITO (Coons) y MULTI-PARCHE de áreas · #52 (Fase 1)
//
// Generaliza el mallador de bloque (`mesher.js`): en vez de 4 esquinas con lados
// RECTOS, acepta una región de 4 lados definida por 4 **curvas-borde** (polilíneas
// de nodos). La malla sigue los bordes por **interpolación transfinita de Coons**:
//
//   S(u,v) = (1−v)·B(u) + v·T(u) + (1−u)·L(v) + u·R(v)
//            − [ (1−u)(1−v)P₀₀ + u(1−v)P₁₀ + (1−u)v·P₀₁ + u·v·P₁₁ ]
//
// Con lados rectos se reduce EXACTAMENTE a la interpolación bilineal de `mesher.js`,
// así que es un superconjunto: cubre rectángulos, trapecios, paralelogramos y
// cuadriláteros con bordes curvos/poligonales — el caso «mejor y más rápido que un
// rectángulo» de muros, tableros y losas irregulares.  Genera QUAD (mejor: QUAD4 +
// MITC4) o CST/DKT.
//
// Multi-parche: varias regiones de 4 lados se mallan por separado y se **sueldan**
// los nodos coincidentes (tolerancia), de modo que plantas en L/U/con quiebres se
// arman como 2–3 parches que quedan conformes automáticamente (submapping manual).
//
// AUTÓNOMO (sin dependencias salvo la conectividad de `mesher.js`) → verificable en
// Node.  Índice de grilla idéntico a mesher.js: idx(i,j)=i*(ny+1)+j.
// ──────────────────────────────────────────────────────────────────────────────
import { blockCells, cornerGridIndices } from './mesher.js?v=181';

// Re-export de la conectividad (misma convención de grilla) para comodidad.
export { blockCells, cornerGridIndices };

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Reparametriza una polilínea [[x,y,z],…] a n+1 puntos equiespaciados por LONGITUD
// DE ARCO (de modo que la densidad de nodos sea uniforme aunque los puntos de
// control estén desparejos). Con 2 puntos da la recta subdividida en n tramos.
export function resamplePolyline(poly, n) {
  if (!Array.isArray(poly) || poly.length < 2) throw new Error('polilínea con <2 puntos');
  if (n < 1) throw new Error('n debe ser ≥ 1');
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + dist(poly[i - 1], poly[i]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) throw new Error('polilínea de longitud nula');
  const out = [];
  let seg = 0;
  for (let k = 0; k <= n; k++) {
    const s = total * k / n;
    while (seg < poly.length - 2 && cum[seg + 1] < s) seg++;
    const segLen = cum[seg + 1] - cum[seg] || 1;
    const t = Math.min(Math.max((s - cum[seg]) / segLen, 0), 1);
    const a = poly[seg], b = poly[seg + 1];
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
  }
  return out;
}

// Malla transfinita de una región de 4 lados.
//   edges = { bottom, right, top, left }  (cada uno polilínea [[x,y,z],…])
//   Orientación: bottom P₀₀→P₁₀ (v=0), top P₀₁→P₁₁ (v=1), left P₀₀→P₀₁ (u=0),
//   right P₁₀→P₁₁ (u=1).  Las esquinas deben coincidir entre lados contiguos.
//   bottom/top se muestrean a nx+1 puntos; left/right a ny+1.
// Devuelve pts[idx(i,j)] con idx(i,j)=i*(ny+1)+j, i∈[0,nx], j∈[0,ny].
export function coonsGrid(edges, nx, ny) {
  const B = resamplePolyline(edges.bottom, nx), T = resamplePolyline(edges.top, nx);
  const L = resamplePolyline(edges.left, ny),  R = resamplePolyline(edges.right, ny);
  const P00 = B[0], P10 = B[nx], P01 = T[0], P11 = T[nx];
  const pts = new Array((nx + 1) * (ny + 1));
  for (let i = 0; i <= nx; i++) {
    const u = i / nx;
    for (let j = 0; j <= ny; j++) {
      const v = j / ny;
      const s = new Array(3);
      for (let c = 0; c < 3; c++) {
        s[c] = (1 - v) * B[i][c] + v * T[i][c] + (1 - u) * L[j][c] + u * R[j][c]
             - ((1 - u) * (1 - v) * P00[c] + u * (1 - v) * P10[c] + (1 - u) * v * P01[c] + u * v * P11[c]);
      }
      pts[i * (ny + 1) + j] = s;
    }
  }
  return pts;
}

// Conveniencia: 4 esquinas (lados rectos) → idéntica a bilinearGrid de mesher.js.
// corners = [P1,P2,P3,P4] CCW con P1=P₀₀, P2=P₁₀, P3=P₁₁, P4=P₀₁.
export function coonsGridFromCorners(corners, nx, ny) {
  const [P1, P2, P3, P4] = corners;
  return coonsGrid({ bottom: [P1, P2], right: [P2, P3], top: [P4, P3], left: [P1, P4] }, nx, ny);
}

// Jacobiano escalado mínimo de un cuadrilátero (corners en orden p0,p1,p2,p3).
// >0 = válido (no invertido); ≈1 = casi-cuadrado; ≤0 = invertido/degenerado.
// Trabaja en 3D usando la normal media de la celda (sirve para shells inclinados).
export function quadMinScaledJacobian(p0, p1, p2, p3) {
  const P = [p0, p1, p2, p3];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // Normal media (suma de las normales de las 4 esquinas).
  let nrm = [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const e1 = sub(P[(i + 1) % 4], P[i]), e2 = sub(P[(i + 3) % 4], P[i]);
    const c = cross(e1, e2);
    nrm = [nrm[0] + c[0], nrm[1] + c[1], nrm[2] + c[2]];
  }
  const nl = Math.hypot(...nrm) || 1; nrm = nrm.map(x => x / nl);
  let mn = Infinity;
  for (let i = 0; i < 4; i++) {
    const e1 = sub(P[(i + 1) % 4], P[i]), e2 = sub(P[(i + 3) % 4], P[i]);
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    if (l1 < 1e-12 || l2 < 1e-12) return -1;
    const c = cross(e1, e2);
    const sj = (c[0] * nrm[0] + c[1] * nrm[1] + c[2] * nrm[2]) / (l1 * l2);   // sin del ángulo, con signo
    mn = Math.min(mn, sj);
  }
  return mn;
}

// Calidad de toda la malla: mínimo Jacobiano escalado sobre todas las celdas QUAD.
export function meshQuality(pts, nx, ny) {
  const idx = (i, j) => i * (ny + 1) + j;
  let minJac = Infinity;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const q = quadMinScaledJacobian(pts[idx(i, j)], pts[idx(i + 1, j)], pts[idx(i + 1, j + 1)], pts[idx(i, j + 1)]);
    minJac = Math.min(minJac, q);
  }
  return { minJac, inverted: minJac <= 0 };
}

// ── Soldadura (welding) de puntos coincidentes ──────────────────────────────────
// Devuelve { unique:[[x,y,z]…], remap:[origIdx→uniqueIdx] }. Hash espacial por
// celdas de tamaño tol → O(n) en la práctica.
export function weldPoints(points, tol = 1e-6) {
  const inv = 1 / Math.max(tol, 1e-12);
  const key = (p) => `${Math.round(p[0] * inv)},${Math.round(p[1] * inv)},${Math.round(p[2] * inv)}`;
  const map = new Map(); const unique = []; const remap = [];
  for (const p of points) {
    // Busca en la celda y vecinas (un punto cerca del borde de celda).
    let found = -1;
    const bx = Math.round(p[0] * inv), by = Math.round(p[1] * inv), bz = Math.round(p[2] * inv);
    outer:
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const arr = map.get(`${bx + dx},${by + dy},${bz + dz}`);
      if (!arr) continue;
      for (const ui of arr) if (dist(unique[ui], p) <= tol) { found = ui; break outer; }
    }
    if (found < 0) { found = unique.length; unique.push(p); const k = key(p); if (!map.has(k)) map.set(k, []); map.get(k).push(found); }
    remap.push(found);
  }
  return { unique, remap };
}

// ── Integración con el Model ────────────────────────────────────────────────────
// Índice espacial de los nodos existentes del modelo (para soldar la malla nueva).
function nodeHash(model, tol) {
  const inv = 1 / Math.max(tol, 1e-12);
  const h = new Map();
  for (const n of model.nodes.values()) {
    const k = `${Math.round(n.x * inv)},${Math.round(n.y * inv)},${Math.round(n.z * inv)}`;
    if (!h.has(k)) h.set(k, []); h.get(k).push(n.id);
  }
  return { h, inv };
}
function findOrAddNode(model, hash, p, tol) {
  const { h, inv } = hash;
  const bx = Math.round(p[0] * inv), by = Math.round(p[1] * inv), bz = Math.round(p[2] * inv);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const arr = h.get(`${bx + dx},${by + dy},${bz + dz}`);
    if (!arr) continue;
    for (const id of arr) { const n = model.nodes.get(id); if (n && Math.hypot(n.x - p[0], n.y - p[1], n.z - p[2]) <= tol) return id; }
  }
  const nd = model.addNode(p[0], p[1], p[2]);
  const k = `${bx},${by},${bz}`; if (!h.has(k)) h.set(k, []); h.get(k).push(nd.id);
  return nd.id;
}

/**
 * Malla una región de 4 lados dentro del modelo, soldando a los nodos existentes.
 * @param {Model} model
 * @param {object} edges  { bottom, right, top, left } polilíneas [[x,y,z]…] (o usa
 *                        coonsGridFromCorners para 4 esquinas)
 * @param {object} opts   { nx, ny, tri, thickness, behavior, planeStrain, matId, weldTol }
 * @returns { nodeIds, areaIds, minJac }
 */
export function meshRegionIntoModel(model, edges, opts = {}) {
  const nx = Math.max(1, Math.round(opts.nx ?? 1)), ny = Math.max(1, Math.round(opts.ny ?? 1));
  const tri = !!opts.tri, tol = opts.weldTol ?? 1e-6;
  const pts = coonsGrid(edges, nx, ny);
  const { minJac } = meshQuality(pts, nx, ny);
  const matId = opts.matId ?? [...model.materials.keys()][0];
  const hash = nodeHash(model, tol);
  const nodeIds = pts.map(p => findOrAddNode(model, hash, p, tol));
  const areaIds = [];
  for (const cell of blockCells(nx, ny, tri)) {
    const a = model.addArea(cell.map(g => nodeIds[g]), matId,
      { thickness: opts.thickness ?? 0.2, behavior: opts.behavior ?? 'membrane', planeStrain: !!opts.planeStrain });
    if (a) areaIds.push(a.id);
  }
  return { nodeIds, areaIds, minJac };
}

// Malla varios parches (submapping manual de plantas en L/U/quiebres). Cada parche
// = { edges|corners, nx, ny, tri?, thickness?, behavior?, planeStrain?, matId? }.
// Los nodos compartidos entre parches se sueldan → malla conforme automáticamente.
export function meshPatchesIntoModel(model, patches, opts = {}) {
  const out = [];
  for (const pch of patches) {
    const edges = pch.edges || (pch.corners
      ? { bottom: [pch.corners[0], pch.corners[1]], right: [pch.corners[1], pch.corners[2]], top: [pch.corners[3], pch.corners[2]], left: [pch.corners[0], pch.corners[3]] }
      : null);
    if (!edges) throw new Error('parche sin edges ni corners');
    out.push(meshRegionIntoModel(model, edges, { ...opts, ...pch }));
  }
  return out;
}
