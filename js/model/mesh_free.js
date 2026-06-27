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
import { quadMinScaledJacobian, weldPoints } from './mesh_map.js?v=209';
import { triQuality, quadQuality, boundaryNodes, laplacianSmooth } from './mesh_quality.js?v=209';
import { maxWeightMatching } from './matching.js?v=209';

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

// ── 3b. Refinamiento ADAPTATIVO por arista más larga (Rivara, conforme) ──────────
// Subdivide selectivamente donde el tamaño objetivo `targetFn(x,y)` es menor que la
// arista, manteniendo la malla CONFORME (sin nodos colgantes): se usa un conjunto
// GLOBAL de aristas a bisecar + caché de puntos medios compartidos, con CLAUSURA de
// arista más larga (Rivara) → garantiza terminación y buenos ángulos.  Cada triángulo
// se parte en 2/3/4 según cuántas de sus aristas estén marcadas.
function splitTri(V, tri, marked, getMid) {
  const ek = (x, y) => x < y ? `${x},${y}` : `${y},${x}`;
  const [a, b, c] = tri;
  const E = [[a, b], [b, c], [c, a]];
  const mk = E.map(([x, y]) => marked.has(ek(x, y)));
  const n = (mk[0] ? 1 : 0) + (mk[1] ? 1 : 0) + (mk[2] ? 1 : 0);
  if (n === 0) return [tri];
  if (n === 3) { const ab = getMid(a, b), bc = getMid(b, c), ca = getMid(c, a); return [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]; }
  if (n === 1) { const i = mk.indexOf(true); const [x, y] = E[i]; const z = tri[(i + 2) % 3]; const m = getMid(x, y); return [[x, m, z], [m, y, z]]; }
  // n === 2: rota para que la arista NO marcada sea CA → AB y BC marcadas
  const u = mk.indexOf(false);
  let A, B, C;
  if (u === 0) { A = b; B = c; C = a; } else if (u === 1) { A = c; B = a; C = b; } else { A = a; B = b; C = c; }
  const p = getMid(A, B), q = getMid(B, C);
  const out = [[p, B, q]];                                 // esquina en B
  const d = (i, j) => Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1]);
  if (d(A, q) <= d(p, C)) out.push([A, p, q], [A, q, C]);  // diagonal más corta (mejor forma)
  else out.push([A, p, C], [p, q, C]);
  return out;
}

export function adaptiveRefine(V, tris, targetFn, opts = {}) {
  const maxPass = opts.maxPass ?? 6;
  const ek = (x, y) => x < y ? `${x},${y}` : `${y},${x}`;
  const len = (x, y) => Math.hypot(V[x][0] - V[y][0], V[x][1] - V[y][1]);
  const longest = (t) => { let bi = 0, bl = -1; for (let i = 0; i < 3; i++) { const l = len(t[i], t[(i + 1) % 3]); if (l > bl) { bl = l; bi = i; } } return bi; };
  for (let pass = 0; pass < maxPass; pass++) {
    const marked = new Set();
    for (const t of tris) {
      const cx = (V[t[0]][0] + V[t[1]][0] + V[t[2]][0]) / 3, cy = (V[t[0]][1] + V[t[1]][1] + V[t[2]][1]) / 3;
      const li = longest(t);
      if (len(t[li], t[(li + 1) % 3]) > targetFn(cx, cy) * 1.0000001) marked.add(ek(t[li], t[(li + 1) % 3]));
    }
    if (!marked.size) break;
    // clausura de Rivara: todo triángulo con alguna arista marcada marca también su arista más larga
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of tris) {
        let any = false; for (let i = 0; i < 3; i++) if (marked.has(ek(t[i], t[(i + 1) % 3]))) { any = true; break; }
        if (!any) continue;
        const li = longest(t), k = ek(t[li], t[(li + 1) % 3]);
        if (!marked.has(k)) { marked.add(k); changed = true; }
      }
    }
    const mid = new Map();
    const getMid = (x, y) => { const k = ek(x, y); if (mid.has(k)) return mid.get(k); V.push([(V[x][0] + V[y][0]) / 2, (V[x][1] + V[y][1]) / 2]); mid.set(k, V.length - 1); return V.length - 1; };
    const out = [];
    for (const t of tris) for (const nt of splitTri(V, t, marked, getMid)) out.push(nt);
    tris = out;
  }
  return tris;
}

// Campo de tamaño por CURVATURA del contorno: refina cerca de esquinas REENTRANTES
// (entrante en el material → concentración de tensiones, p.ej. el ángulo interior de
// una L) y de PUNTAS muy agudas.  Devuelve targetFn(x,y) = tamaño objetivo: hmin en la
// esquina, creciendo linealmente (gradiente `grade`) hasta h lejos de ella.
// `rings` = anillos del dominio [outer, …holes] en 2D; el primero es el contorno (CCW),
// los demás agujeros (CW); por eso TODA esquina convexa de un agujero es reentrante
// para el material y también se refina.
function buildCurvatureSizeField(rings, h, cfg = {}) {
  const hmin = cfg.hmin ?? h / 2;
  const grade = cfg.grade ?? 0.5;
  const reentrant = cfg.reentrant ?? 200;   // ángulo interior (°) > esto → reentrante
  const acute = cfg.acute ?? 50;            // ángulo interior (°) < esto → punta aguda
  const corners = [];
  rings.forEach((ringIn, ri) => {
    if (ringIn.length < 3) return;
    // orienta: contorno CCW (área>0), agujeros CW (área<0) → el ángulo interior medido es el del MATERIAL
    let ring = ringIn.slice(); const area = signedArea2(ring);
    if ((ri === 0 && area < 0) || (ri > 0 && area > 0)) ring = ring.reverse();
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
      const dix = b[0] - a[0], diy = b[1] - a[1], dox = c[0] - b[0], doy = c[1] - b[1];   // dir. entrante/saliente
      const turn = Math.atan2(dix * doy - diy * dox, dix * dox + diy * doy) * 180 / Math.PI;  // giro exterior firmado
      const interior = 180 - turn;            // CCW: ángulo interior del material
      if (interior > reentrant || interior < acute) corners.push([b[0], b[1]]);
    }
  });
  if (!corners.length) return null;
  return (x, y) => {
    let s = h;
    for (const P of corners) { const d = Math.hypot(x - P[0], y - P[1]); const v = hmin + grade * d; if (v < s) s = v; }
    return Math.max(hmin, Math.min(h, s));
  };
}

// ── 4. Recombinación a cuadriláteros ─────────────────────────────────────────────
// Empareja triángulos adyacentes que formen un buen quad.  Por defecto resuelve el
// EMPAREJAMIENTO DE PESO MÁXIMO exacto (Edmonds/«Blossom», `matching.js`) sobre el
// grafo «triángulo–triángulo» con peso = calidad del quad → óptimo GLOBAL (más quads
// y de mejor calidad que el emparejado voraz, como en Gmsh).  `opts.blossom===false`
// vuelve al voraz (orden por calidad descendente). Devuelve celdas [tri…] + [quad…].
//   opts.cost = 'gmsh' (def.) → peso = calidad ANGULAR de Remacle η=1−(2/π)·máx|90°−θ|
//               (el criterio de blossom-quad de Gmsh, premia ángulos rectos);
//             = 'jac'        → peso = Jacobiano escalado mínimo (forma).
// El Jacobiano escalado SIEMPRE filtra la validez (jac>minJac descarta quads cóncavos).
export function recombineToQuads(V, tris, minJac = 0.30, opts = {}) {
  const cost = opts.cost ?? 'gmsh';
  const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  const edge = new Map();
  tris.forEach((t, ti) => { for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3], opp = t[(e + 2) % 3]; const k = key(a, b); if (!edge.has(k)) edge.set(k, []); edge.get(k).push({ ti, opp, a, b }); } });
  const cands = [];
  const lift = (i) => [V[i][0], V[i][1], 0];
  for (const [, arr] of edge) {
    if (arr.length !== 2) continue;
    const [e1, e2] = arr; const u = e1.a, v = e1.b, p = e1.opp, q = e2.opp;
    const quad = [p, u, q, v];   // alrededor: apex t1 → comp → apex t2 → comp
    const P = [lift(quad[0]), lift(quad[1]), lift(quad[2]), lift(quad[3])];
    const jac = quadMinScaledJacobian(...P);
    if (jac <= minJac) continue;                          // descarta quads inválidos/cóncavos
    let w = jac;
    if (cost === 'gmsh') { const qq = quadQuality(...P); w = Math.max(0, 1 - Math.max(Math.abs(90 - qq.minAngle), Math.abs(90 - qq.maxAngle)) / 90); }
    cands.push({ t1: e1.ti, t2: e2.ti, quad, jac: w });
  }
  const used = new Array(tris.length).fill(false);
  const cells = [];

  if (opts.blossom !== false && cands.length) {
    // Grafo de matching: vértices = triángulos, aristas = quads candidatos.
    // Peso entero = calidad·SCALE (la aritmética de duales del Blossom es exacta así).
    // COSTO DE BORDE tipo Blossom-IV (Gmsh): con `maxCardinality` (def.) se suma un BONO
    // constante por arista, dominante sobre la calidad → el matching maximiza primero el
    // NÚMERO de quads (menos triángulos sobrantes) y la calidad sólo desempata; usa el
    // mismo camino verificado de peso máximo (no el de cardinalidad pura).
    const SCALE = 1e6;
    const maxCard = opts.maxCardinality !== false;
    const BONUS = maxCard ? SCALE * (tris.length + 1) : 0;
    const mEdges = cands.map(c => [c.t1, c.t2, BONUS + Math.max(1, Math.round(c.jac * SCALE))]);
    const quadByPair = new Map();
    for (const c of cands) quadByPair.set(key(c.t1, c.t2), c.quad);
    const mate = maxWeightMatching(mEdges, tris.length);
    for (let a = 0; a < mate.length; a++) {
      const b = mate[a];
      if (b > a && !used[a] && !used[b]) {
        const quad = quadByPair.get(key(a, b));
        if (quad) { cells.push(quad); used[a] = used[b] = true; }
      }
    }
  } else {
    // Emparejado voraz (fallback): mejor calidad primero, sin conflictos.
    cands.sort((a, b) => b.jac - a.jac);
    for (const c of cands) { if (used[c.t1] || used[c.t2]) continue; used[c.t1] = used[c.t2] = true; cells.push(c.quad); }
  }
  tris.forEach((t, ti) => { if (!used[ti]) cells.push(t); });
  return cells;
}

// ── Optimización TOPOLÓGICA de valencia (edge-flips por regularidad) ─────────────
// Voltea aristas interiores de la triangulación para acercar la VALENCIA de cada nodo
// a la ideal (6 interior, 4 borde): minimiza Σ(val−ideal)² localmente.  Complementa a
// los flips de Delaunay (que optimizan ÁNGULOS): una triangulación con valencias
// regulares se recombina en quads más uniformes.  Sólo acepta un flip si (a) reduce la
// desviación de valencia, (b) no invierte y (c) no degrada en exceso la forma de las
// dos celdas (guardia de calidad).  El costo decrece estrictamente → termina.
export function valenceOptimize(V, tris, opts = {}) {
  const maxPass = opts.maxPass ?? 20;
  const qGuard = opts.qGuard ?? 0.5;       // calidad mín. del par ≥ qGuard·(antes)
  const nV = V.length;
  const bnd = boundaryNodes(V.map(p => [p[0], p[1], 0]), tris);
  const ideal = (v) => bnd.has(v) ? 4 : 6;
  const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  const triQ = (a, b, c) => triQuality([V[a][0], V[a][1], 0], [V[b][0], V[b][1], 0], [V[c][0], V[c][1], 0]).quality;
  tris = tris.map(t => t.slice());

  for (let pass = 0; pass < maxPass; pass++) {
    // valencia (nº de aristas incidentes) por nodo
    const val = new Array(nV).fill(0); const seen = new Set();
    for (const t of tris) for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3], k = key(a, b); if (!seen.has(k)) { seen.add(k); val[a]++; val[b]++; } }
    // arista → triángulos incidentes
    const edge = new Map();
    tris.forEach((t, ti) => { for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3], opp = t[(e + 2) % 3]; const k = key(a, b); if (!edge.has(k)) edge.set(k, []); edge.get(k).push({ ti, opp, a, b }); } });
    const dirty = new Array(tris.length).fill(false);
    let flipped = false;
    for (const [, arr] of edge) {
      if (arr.length !== 2) continue;
      const [e1, e2] = arr;
      if (dirty[e1.ti] || dirty[e2.ti]) continue;
      const u = e1.a, v = e1.b, p = e1.opp, q = e2.opp;
      if (p === q || edge.has(key(p, q))) continue;        // ya existe esa arista → no-manifold
      // ¿mejora la valencia?  (sólo cambian u,v,p,q)
      const cost = (x, d) => { const t = val[x] + d - ideal(x); return t * t; };
      const before = cost(u, 0) + cost(v, 0) + cost(p, 0) + cost(q, 0);
      const after = cost(u, -1) + cost(v, -1) + cost(p, 1) + cost(q, 1);
      if (after >= before) continue;
      // validez + guardia de calidad geométrica (mismas combinaciones que delaunayFlips)
      let t1n = [p, u, q], t2n = [p, q, v];
      if (!(triArea(V[t1n[0]], V[t1n[1]], V[t1n[2]]) > EPS && triArea(V[t2n[0]], V[t2n[1]], V[t2n[2]]) > EPS)) {
        t1n = [p, q, u]; t2n = [p, v, q];
        if (!(triArea(V[t1n[0]], V[t1n[1]], V[t1n[2]]) > EPS && triArea(V[t2n[0]], V[t2n[1]], V[t2n[2]]) > EPS)) continue;
      }
      const T1 = tris[e1.ti], T2 = tris[e2.ti];
      const qOld = Math.min(triQ(T1[0], T1[1], T1[2]), triQ(T2[0], T2[1], T2[2]));
      const qNew = Math.min(triQ(t1n[0], t1n[1], t1n[2]), triQ(t2n[0], t2n[1], t2n[2]));
      if (qNew < qGuard * qOld) continue;                  // no degradar la forma por la valencia
      tris[e1.ti] = t1n; tris[e2.ti] = t2n;
      val[u]--; val[v]--; val[p]++; val[q]++;
      dirty[e1.ti] = dirty[e2.ti] = true; flipped = true;
    }
    if (!flipped) break;
  }
  return tris;
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
 * @param {object} opts  { h, levels, recombine, blossom, valence, adaptive, minQuad, smooth, holes }
 *   h        = tamaño de elemento objetivo (deriva los niveles de refinamiento)
 *   levels   = niveles de refinamiento uniforme explícitos (alternativa a h)
 *   blossom  = recombinación a quad por matching de peso máximo (Edmonds); false = voraz
 *   valence  = optimización topológica de valencia (edge-flips de regularidad) antes de recombinar
 *   adaptive = refinamiento por curvatura del contorno (esquinas reentrantes/agudas); def. true
 *   maxCardinality = costo de borde Blossom-IV: maximiza el nº de quads (def. true)
 *   sizeField = función (x,y)→tamaño objetivo del usuario (se combina con la curvatura por mínimo)
 *   adaptiveOpts = { hmin, grade, maxPass, reentrant, acute } del campo de tamaño por curvatura
 *   holes    = lista de agujeros (cada uno un anillo [[x,y]…]); se fusionan por puentes.
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
  // Refinamiento ADAPTATIVO por curvatura: más fino en esquinas reentrantes/agudas del
  // contorno (concentración de tensiones), conforme por bisección de arista más larga.
  if (opts.adaptive !== false && opts.h > 0) {
    const rings = [outer, ...(opts.holes || [])];
    const curv = buildCurvatureSizeField(rings, opts.h, opts.adaptiveOpts || {});
    // Campo de tamaño DEFINIDO POR EL USUARIO (opcional): función (x,y)→tamaño objetivo en
    // coords del plano de mallado.  Se combina con la curvatura tomando el mínimo (lo más fino).
    const user = (typeof opts.sizeField === 'function') ? opts.sizeField : null;
    const sizeFn = (curv && user) ? ((x, y) => Math.min(curv(x, y), user(x, y))) : (curv || user);
    if (sizeFn) { tris = adaptiveRefine(V, tris, sizeFn, opts.adaptiveOpts || {}); tris = delaunayFlips(V, tris); }
  }
  // Optimización topológica de valencia (regulariza la malla antes de recombinar).
  if (opts.valence !== false) tris = valenceOptimize(V, tris, opts.valenceOpts || {});
  let cells = (opts.recombine !== false) ? recombineToQuads(V, tris, opts.minQuad ?? 0.30, { blossom: opts.blossom !== false, maxCardinality: opts.maxCardinality, cost: opts.cost }) : tris;
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
