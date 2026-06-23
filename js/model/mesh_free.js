// ──────────────────────────────────────────────────────────────────────────────
// mesh_free.js — Malla LIBRE de polígonos arbitrarios (triángulo / quad) · #52 (F3)
//
// Malla un polígono simple (cóncavo permitido: plantas en L/U, formas irregulares)
// sin necesidad de descomponerlo en bloques de 4 lados:
//   1. EAR CLIPPING  → triangulación inicial conforme (maneja vértices reentrantes).
//   2. FLIPS de DELAUNAY (Lawson) → mejora ángulos (in-circle).
//   3. REFINAMIENTO uniforme 1→4 (midpoints compartidos) → tamaño objetivo h.
//   4. RECOMBINACIÓN a CUADRILÁTEROS (emparejado voraz) → malla QUAD-dominante.
//   5. SUAVIZADO Laplaciano (mesh_quality) → limpia la forma de los elementos.
//
// Trabaja en 2D; `meshPolygonIntoModel` proyecta un polígono 3D a su plano, malla y
// mapea de vuelta (sirve para cáscaras inclinadas).  AUTÓNOMO → verificable en Node.
//
// Soporta AGUJEROS (opts.holes): cada hueco se fusiona al contorno con un puente de
// ancho cero (bridging estilo earcut) → polígono simple que ear-clipping triangula.
// ──────────────────────────────────────────────────────────────────────────────
import { quadMinScaledJacobian, weldPoints } from './mesh_map.js?v=166';
import { triQuality, boundaryNodes, laplacianSmooth } from './mesh_quality.js?v=166';

const EPS = 1e-9;
const signedArea2 = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const triArea = (a, b, c) => 0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));

function pointInTri(p, a, b, c) {
  const d1 = triArea(p, a, b), d2 = triArea(p, b, c), d3 = triArea(p, c, a);
  const neg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const pos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(neg && pos);   // todos del mismo signo (o sobre el borde) → dentro
}

// ── 1. Ear clipping (polígono simple, índices CCW) ──────────────────────────────
export function earClip(V, polyIdx) {
  let idx = polyIdx.slice();
  if (signedArea2(idx.map(i => V[i])) < 0) idx.reverse();   // asegura CCW
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    const n = idx.length;
    let ear = -1;
    for (let i = 0; i < n; i++) {
      const a = idx[(i - 1 + n) % n], b = idx[i], c = idx[(i + 1) % n];
      if (triArea(V[a], V[b], V[c]) <= EPS) continue;        // reflejo o colineal → no es oreja
      let contains = false;
      const coincide = (P, Q) => Math.abs(P[0] - Q[0]) < 1e-9 && Math.abs(P[1] - Q[1]) < 1e-9;
      for (let j = 0; j < n; j++) {
        const p = idx[j]; if (p === a || p === b || p === c) continue;
        const P = V[p];
        // saltar puntos COINCIDENTES con un vértice de la oreja (puentes de agujeros)
        if (coincide(P, V[a]) || coincide(P, V[b]) || coincide(P, V[c])) continue;
        if (pointInTri(P, V[a], V[b], V[c])) { contains = true; break; }
      }
      if (contains) continue;
      tris.push([a, b, c]); idx.splice(i, 1); ear = i; break;
    }
    if (ear < 0) break;   // degenerado: no se halló oreja
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

// ── 2. Flips de Delaunay (Lawson) ───────────────────────────────────────────────
function inCircle(a, b, c, d) {
  // >0 ⇒ d dentro del circuncírculo de (a,b,c) con (a,b,c) CCW.
  const ax = a[0] - d[0], ay = a[1] - d[1], bx = b[0] - d[0], by = b[1] - d[1], cx = c[0] - d[0], cy = c[1] - d[1];
  return (ax * ax + ay * ay) * (bx * cy - cx * by)
       - (bx * bx + by * by) * (ax * cy - cx * ay)
       + (cx * cx + cy * cy) * (ax * by - bx * ay);
}
const ccw = (V, t) => triArea(V[t[0]], V[t[1]], V[t[2]]) > 0 ? t : [t[0], t[2], t[1]];

export function delaunayFlips(V, tris, maxPass = 30) {
  tris = tris.map(t => ccw(V, t.slice()));
  const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  for (let pass = 0; pass < maxPass; pass++) {
    const edge = new Map();   // key → [{ti, opp}]
    tris.forEach((t, ti) => { for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3], opp = t[(e + 2) % 3]; const k = key(a, b); if (!edge.has(k)) edge.set(k, []); edge.get(k).push({ ti, opp, a, b }); } });
    let flipped = false;
    for (const [, arr] of edge) {
      if (arr.length !== 2) continue;
      const [e1, e2] = arr; const t1 = tris[e1.ti], t2 = tris[e2.ti];
      if (!t1 || !t2) continue;
      const u = e1.a, v = e1.b, p = e1.opp, q = e2.opp;
      if (p === q) continue;
      // ¿no-Delaunay? q dentro del circuncírculo de (u,v,p) (con t1 CCW)
      const tA = ccw(V, [u, v, p]);
      if (inCircle(V[tA[0]], V[tA[1]], V[tA[2]], V[q]) <= EPS) continue;
      // flip → nuevos triángulos (p,q,v) y (q,p,u); válidos sólo si convexos
      const n1 = [p, u, q], n2 = [p, q, v];
      if (triArea(V[n1[0]], V[n1[1]], V[n1[2]]) <= EPS || triArea(V[n2[0]], V[n2[1]], V[n2[2]]) <= EPS) {
        const m1 = [p, q, u], m2 = [p, v, q];
        if (triArea(V[m1[0]], V[m1[1]], V[m1[2]]) <= EPS || triArea(V[m2[0]], V[m2[1]], V[m2[2]]) <= EPS) continue;
        tris[e1.ti] = ccw(V, m1); tris[e2.ti] = ccw(V, m2);
      } else { tris[e1.ti] = ccw(V, n1); tris[e2.ti] = ccw(V, n2); }
      flipped = true; break;   // rehacer adyacencia tras cada flip (robusto)
    }
    if (!flipped) break;
  }
  return tris;
}

// ── 3. Refinamiento uniforme 1→4 (midpoints compartidos = conforme) ─────────────
export function uniformRefine(V, tris) {
  const mid = new Map();
  const getMid = (a, b) => { const k = a < b ? `${a},${b}` : `${b},${a}`; if (mid.has(k)) return mid.get(k); V.push([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2]); mid.set(k, V.length - 1); return V.length - 1; };
  const out = [];
  for (const [a, b, c] of tris) { const ab = getMid(a, b), bc = getMid(b, c), ca = getMid(c, a); out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]); }
  return out;
}

// ── 4. Recombinación a cuadriláteros (emparejado voraz por calidad) ──────────────
export function recombineToQuads(V, tris, minJac = 0.30) {
  const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  const edge = new Map();
  tris.forEach((t, ti) => { for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3], opp = t[(e + 2) % 3]; const k = key(a, b); if (!edge.has(k)) edge.set(k, []); edge.get(k).push({ ti, opp, a, b }); } });
  const cands = [];
  const lift = (i) => [V[i][0], V[i][1], 0];
  for (const [, arr] of edge) {
    if (arr.length !== 2) continue;
    const [e1, e2] = arr; const u = e1.a, v = e1.b, p = e1.opp, q = e2.opp;
    const quad = [p, u, q, v];   // alrededor: apex t1 → comp → apex t2 → comp
    const jac = quadMinScaledJacobian(lift(quad[0]), lift(quad[1]), lift(quad[2]), lift(quad[3]));
    if (jac > minJac) cands.push({ t1: e1.ti, t2: e2.ti, quad, jac });
  }
  cands.sort((a, b) => b.jac - a.jac);
  const used = new Array(tris.length).fill(false);
  const cells = [];
  for (const c of cands) { if (used[c.t1] || used[c.t2]) continue; used[c.t1] = used[c.t2] = true; cells.push(c.quad); }
  tris.forEach((t, ti) => { if (!used[ti]) cells.push(t); });
  return cells;
}

// ── Agujeros: fusión de huecos en el contorno (bridging estilo earcut) ──────────
// Conecta cada agujero al contorno exterior con un "puente" de ancho cero → un único
// polígono simple que ear-clipping puede triangular. Outer CCW, agujeros CW.
function bridgeHole(ring, hole) {
  let mi = 0; for (let i = 1; i < hole.length; i++) if (hole[i][0] > hole[mi][0]) mi = i;   // vértice del agujero más a la derecha
  const M = hole[mi];
  // arista del contorno que cruza el rayo +x desde M; se elige el vértice a su derecha
  let qx = -Infinity, bi = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (a[1] === b[1]) continue;
    if (M[1] <= Math.max(a[1], b[1]) && M[1] >= Math.min(a[1], b[1])) {
      const x = a[0] + (M[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
      if (x >= M[0] - EPS && x > qx) { qx = x; bi = (a[0] >= b[0]) ? i : (i + 1) % ring.length; }
    }
  }
  if (bi < 0) return ring.concat(hole);   // fallback (no debería)
  const holeSeq = []; for (let k = 0; k <= hole.length; k++) holeSeq.push(hole[(mi + k) % hole.length]);   // m … m
  const merged = [];
  for (let i = 0; i <= bi; i++) merged.push(ring[i]);
  for (const pt of holeSeq) merged.push(pt);
  merged.push(ring[bi]);                  // vuelve al vértice puente
  for (let i = bi + 1; i < ring.length; i++) merged.push(ring[i]);
  return merged;
}
function eliminateHoles(outer, holes) {
  let ring = signedArea2(outer) < 0 ? outer.slice().reverse() : outer.slice();   // exterior CCW
  const H = holes.map(h => signedArea2(h) > 0 ? h.slice().reverse() : h.slice()); // agujeros CW
  H.sort((a, b) => Math.max(...b.map(p => p[0])) - Math.max(...a.map(p => p[0])));
  for (const hole of H) ring = bridgeHole(ring, hole);
  return ring;
}

// ── Orquestador: polígono 2D → malla {V, cells, boundary} ───────────────────────
/**
 * @param {Array} outer  vértices del contorno [[x,y]…] (sin repetir el primero)
 * @param {object} opts  { h, levels, recombine=true, minQuad=0.30, smooth=3, holes:[[[x,y]…]…] }
 *   h       = tamaño de elemento objetivo (deriva los niveles de refinamiento)
 *   levels  = niveles de refinamiento uniforme explícitos (alternativa a h)
 *   holes   = lista de agujeros (cada uno un anillo [[x,y]…]); se fusionan por puentes.
 * @returns { V:[[x,y]…], cells:[[i,j,k]|[i,j,k,l]…], boundary:Set, stats }
 */
export function triangulatePolygon(outer, opts = {}) {
  const hasHoles = opts.holes && opts.holes.length;
  const ring = hasHoles ? eliminateHoles(outer, opts.holes) : outer;
  let V = ring.map(p => [p[0], p[1]]);
  let tris = earClip(V, ring.map((_, i) => i));
  if (hasHoles) {
    // soldar los vértices duplicados de los puentes y descartar triángulos degenerados
    const w = weldPoints(V.map(p => [p[0], p[1], 0]), 1e-7);
    V = w.unique.map(p => [p[0], p[1]]);
    tris = tris.map(t => t.map(i => w.remap[i])).filter(t => t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2] && Math.abs(triArea(V[t[0]], V[t[1]], V[t[2]])) > EPS);
  }
  tris = delaunayFlips(V, tris);
  // niveles de refinamiento desde h
  let levels = opts.levels;
  if (levels == null && opts.h > 0) {
    let maxEdge = 0;
    for (const t of tris) for (let e = 0; e < 3; e++) { const a = V[t[e]], b = V[t[(e + 1) % 3]]; maxEdge = Math.max(maxEdge, Math.hypot(a[0] - b[0], a[1] - b[1])); }
    levels = Math.min(6, Math.max(0, Math.ceil(Math.log2(maxEdge / opts.h))));
  }
  for (let l = 0; l < (levels || 0); l++) { tris = uniformRefine(V, tris); tris = delaunayFlips(V, tris); }
  let cells = (opts.recombine !== false) ? recombineToQuads(V, tris, opts.minQuad ?? 0.30) : tris;
  // suavizado (nodos interiores)
  const sm = opts.smooth ?? 3;
  if (sm > 0) { const V3 = V.map(p => [p[0], p[1], 0]); const r = laplacianSmooth(V3, cells, { iters: sm, omega: 0.5 }); r.nodes.forEach((p, i) => { V[i][0] = p[0]; V[i][1] = p[1]; }); }
  const V3 = V.map(p => [p[0], p[1], 0]);
  const boundary = boundaryNodes(V3, cells);
  return { V, cells, boundary };
}

// ── Integración con el modelo (proyección al plano del polígono) ────────────────
function planeFrame(pts3) {
  // Normal de Newell + marco local (e1 a lo largo de la 1ª arista, e2 = n×e1).
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts3.length; i++) { const a = pts3[i], b = pts3[(i + 1) % pts3.length]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); }
  let nl = Math.hypot(nx, ny, nz); if (nl < 1e-15) { nx = 0; ny = 0; nz = 1; nl = 1; }
  const n = [nx / nl, ny / nl, nz / nl];
  const o = pts3[0];
  let e1 = [pts3[1][0] - o[0], pts3[1][1] - o[1], pts3[1][2] - o[2]];
  const e1l = Math.hypot(...e1) || 1; e1 = e1.map(x => x / e1l);
  const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  return { o, e1, e2, n };
}

/**
 * Malla un polígono (en 3D, plano arbitrario) dentro del modelo.
 * @param {Model} model
 * @param {Array} outer3  contorno [[x,y,z]…]
 * @param {object} opts   { h|levels, recombine, minQuad, smooth, thickness, behavior, planeStrain, matId, weldTol }
 * @returns { nodeIds, areaIds, boundaryNodeIds, stats }
 */
export function meshPolygonIntoModel(model, outer3, opts = {}) {
  const { o, e1, e2 } = planeFrame(outer3);
  const to2D = (p) => { const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]; return [d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2]]; };
  const to3D = (uv) => [o[0] + uv[0] * e1[0] + uv[1] * e2[0], o[1] + uv[0] * e1[1] + uv[1] * e2[1], o[2] + uv[0] * e1[2] + uv[1] * e2[2]];
  const opts2 = { ...opts };
  if (opts.holes && opts.holes.length) opts2.holes = opts.holes.map(h => h.map(to2D));   // proyecta los agujeros al plano
  const { V, cells, boundary } = triangulatePolygon(outer3.map(to2D), opts2);

  const tol = opts.weldTol ?? 1e-6;
  const matId = opts.matId ?? [...model.materials.keys()][0];
  // find-or-add con hash espacial sencillo
  const inv = 1 / Math.max(tol, 1e-12); const hash = new Map();
  for (const nd of model.nodes.values()) { const k = `${Math.round(nd.x * inv)},${Math.round(nd.y * inv)},${Math.round(nd.z * inv)}`; if (!hash.has(k)) hash.set(k, []); hash.get(k).push(nd.id); }
  const findOrAdd = (p) => {
    const bx = Math.round(p[0] * inv), by = Math.round(p[1] * inv), bz = Math.round(p[2] * inv);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const arr = hash.get(`${bx + dx},${by + dy},${bz + dz}`); if (!arr) continue; for (const id of arr) { const n = model.nodes.get(id); if (n && Math.hypot(n.x - p[0], n.y - p[1], n.z - p[2]) <= tol) return id; } }
    const nd = model.addNode(p[0], p[1], p[2]); const k = `${bx},${by},${bz}`; if (!hash.has(k)) hash.set(k, []); hash.get(k).push(nd.id); return nd.id;
  };
  const nodeIds = V.map(uv => findOrAdd(to3D(uv)));
  const areaIds = [];
  for (const c of cells) { const a = model.addArea(c.map(i => nodeIds[i]), matId, { thickness: opts.thickness ?? 0.2, behavior: opts.behavior ?? 'membrane', planeStrain: !!opts.planeStrain }); if (a) areaIds.push(a.id); }
  const boundaryNodeIds = new Set([...boundary].map(i => nodeIds[i]));
  return { nodeIds, areaIds, boundaryNodeIds };
}
