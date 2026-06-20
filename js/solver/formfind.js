// ──────────────────────────────────────────────────────────────────────────────
// formfind.js — Form-finding por el MÉTODO DE DENSIDADES DE FUERZA (FDM, Schek 1974).
//
// Dada una red de barras/cables con una DENSIDAD DE FUERZA q = N/L por rama
// (N = fuerza axial, L = longitud), nodos ANCLA fijos y nodos LIBRES, la forma de
// equilibrio se obtiene resolviendo un sistema LINEAL (tres veces, una por
// coordenada) — sin iterar:
//
//   Equilibrio en cada nodo libre i:  Σ_(rama i-j) q·(x_j − x_i) + p_i = 0
//   ⇒  D·x_libre = p + (aportes de los anclas)
//   con D = matriz tipo Laplaciano ponderada por q (SPD si q>0 y la red llega a
//   los anclas). Misma D para x, y, z.
//
// Es la base del diseño de cubiertas tensadas, mallas de cables y formas
// funiculares (con cargas externas → forma funicular de la carga; sin cargas y
// q uniforme → red de longitud mínima, tipo película de jabón).
//
// AUTÓNOMO (su propio solver denso SPD) para verificarse en Node.
// ──────────────────────────────────────────────────────────────────────────────

// Cholesky denso para D (SPD). Resuelve D·x = b. Devuelve null si no es SPD.
function solveSPD(D, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = D[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 0 || !isFinite(s)) return null; L[i * n + i] = Math.sqrt(s); }
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let j = 0; j < i; j++) s -= L[i * n + j] * y[j]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let j = i + 1; j < n; j++) s -= L[j * n + i] * x[j]; x[i] = s / L[i * n + i]; }
  return x;
}

/**
 * @param {object} o
 *   coords    Float64Array(3·nNode)  coordenadas actuales (semilla)
 *   fixed     boolean[nNode]          true = nodo ancla (no se mueve)
 *   branches  [[i,j], ...]            ramas (índices de nodo) — cables/barras
 *   q         number[]                densidad de fuerza por rama (>0 = tracción)
 *   loads     [[px,py,pz], ...]|null  carga externa por nodo (opcional)
 * @returns { ok, coords, freeIdx, note }
 *   coords = nuevas coordenadas de equilibrio (los anclas quedan igual).
 */
export function formFind(o) {
  const { coords, fixed, branches, q, loads } = o;
  const n = fixed.length;
  const map = new Int32Array(n).fill(-1);
  const freeIdx = [];
  for (let i = 0; i < n; i++) if (!fixed[i]) { map[i] = freeIdx.length; freeIdx.push(i); }
  const nf = freeIdx.length;
  if (nf === 0) return { ok: false, coords: Float64Array.from(coords), freeIdx, note: 'No hay nodos libres (todos son anclas).' };

  const D = new Float64Array(nf * nf);
  const rhs = [new Float64Array(nf), new Float64Array(nf), new Float64Array(nf)];

  for (let b = 0; b < branches.length; b++) {
    const i = branches[b][0], j = branches[b][1];
    const qb = q[b];
    if (!(qb > 0) && !(qb < 0)) continue;   // q=0 → rama inactiva
    const fi = map[i], fj = map[j];
    if (fi >= 0) D[fi * nf + fi] += qb;
    if (fj >= 0) D[fj * nf + fj] += qb;
    if (fi >= 0 && fj >= 0) { D[fi * nf + fj] -= qb; D[fj * nf + fi] -= qb; }
    // aportes de los anclas → al lado derecho
    if (fi >= 0 && fj < 0) for (let c = 0; c < 3; c++) rhs[c][fi] += qb * coords[3 * j + c];
    if (fj >= 0 && fi < 0) for (let c = 0; c < 3; c++) rhs[c][fj] += qb * coords[3 * i + c];
  }
  // cargas externas en nodos libres
  if (loads) for (let i = 0; i < n; i++) {
    const fi = map[i]; if (fi < 0 || !loads[i]) continue;
    for (let c = 0; c < 3; c++) rhs[c][fi] += loads[i][c] || 0;
  }

  const out = Float64Array.from(coords);
  for (let c = 0; c < 3; c++) {
    const x = solveSPD(D, rhs[c], nf);
    if (!x) return { ok: false, coords: out, freeIdx, note: 'La red no es estable con estas densidades (¿nodos libres sin conexión a anclas, o q ≤ 0?).' };
    for (let k = 0; k < nf; k++) out[3 * freeIdx[k] + c] = x[k];
  }
  return { ok: true, coords: out, freeIdx, note: '' };
}
