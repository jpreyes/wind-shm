// ──────────────────────────────────────────────────────────────────────────────
// linsolve.js — solver lineal para K·u = F simétrica definida positiva (SPD).
//
//   · Reordenamiento Reverse Cuthill–McKee (RCM) → minimiza el ancho de banda.
//   · Factorización de Cholesky EN BANDA (almacenamiento perfil) → O(n·b²) en
//     tiempo y O(n·b) en memoria, en vez de O(n³)/O(n²) del solver denso.
//   · Factoriza UNA vez y resuelve MUCHOS lados derechos (varios casos de carga).
//
// Pensado para correr en un Web Worker (no bloquea la UI). Si la matriz NO es
// SPD (mecanismo/inestabilidad → pivote ≤ 0), devuelve { ok:false } para que el
// llamador use un camino de respaldo (solver denso) y/o avise de inestabilidad.
// ──────────────────────────────────────────────────────────────────────────────

// Reverse Cuthill–McKee. adj: lista de adyacencia (vecinos por nodo).
// Devuelve perm: perm[nuevoIndice] = índiceOriginal.
export function rcm(n, adj) {
  const visited = new Uint8Array(n);
  const deg = new Int32Array(n);
  for (let i = 0; i < n; i++) deg[i] = adj[i].length;
  const order = new Int32Array(n);
  let oc = 0;
  while (oc < n) {
    // arranque: nodo no visitado de menor grado (heurística simple y robusta)
    let start = -1, md = Infinity;
    for (let i = 0; i < n; i++) if (!visited[i] && deg[i] < md) { md = deg[i]; start = i; }
    if (start < 0) break;
    // BFS, ordenando vecinos por grado ascendente
    const queue = [start]; visited[start] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi];
      order[oc++] = v;
      const nb = [];
      for (const u of adj[v]) if (!visited[u]) nb.push(u);
      nb.sort((a, b) => deg[a] - deg[b]);
      for (const u of nb) { visited[u] = 1; queue.push(u); }
    }
  }
  // por si quedaron nodos aislados sin alcanzar
  for (let i = 0; i < n && oc < n; i++) if (!visited[i]) { visited[i] = 1; order[oc++] = i; }
  // reverse
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = order[n - 1 - i];
  return perm;
}

// Construye adyacencia desde la matriz densa (Float64Array n×n, row-major).
function adjacencyFromDense(K, n) {
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const off = i * n;
    for (let j = 0; j < n; j++) if (i !== j && K[off + j] !== 0) adj[i].push(j);
  }
  return adj;
}

// Permutación RCM desde la matriz densa (para reordenar K y M a forma de banda).
export function permRCM(Kff, n) { return rcm(n, adjacencyFromDense(Kff, n)); }

// Factoriza Kff (densa, SPD) con RCM + Cholesky en banda. Devuelve un objeto
// factor reutilizable para muchos lados derechos (bandSolve). { ok, L, w, m, perm }.
//   permIn: permutación a usar (si null, se calcula RCM; si se pasa la identidad,
//   se factoriza Kff tal cual — útil cuando ya viene reordenada).
export function bandFactor(Kff, n, permIn = null) {
  if (n === 0) return { ok: true, L: new Float64Array(0), w: 1, m: 0, perm: new Int32Array(0) };

  const perm = permIn || rcm(n, adjacencyFromDense(Kff, n));
  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[perm[i]] = i;

  // ancho de semibanda tras el reordenamiento
  let m = 0;
  for (let i = 0; i < n; i++) {
    const off = i * n, pi = pos[i];
    for (let j = 0; j < n; j++) if (Kff[off + j] !== 0) { const d = Math.abs(pi - pos[j]); if (d > m) m = d; }
  }

  const w = m + 1;
  const L = new Float64Array(n * w);
  for (let i = 0; i < n; i++) {
    const pi = perm[i];
    const j0 = i - m < 0 ? 0 : i - m;
    for (let j = j0; j <= i; j++) L[i * w + (j - i + m)] = Kff[pi * n + perm[j]];
  }
  // Cholesky en banda (in-place): L·Lᵀ = A_perm
  for (let i = 0; i < n; i++) {
    const j0 = i - m < 0 ? 0 : i - m;
    for (let j = j0; j <= i; j++) {
      let s = L[i * w + (j - i + m)];
      const k0 = Math.max(j0, j - m);
      for (let k = k0; k < j; k++) s -= L[i * w + (k - i + m)] * L[j * w + (k - j + m)];
      if (i === j) {
        if (s <= 0 || !isFinite(s)) return { ok: false, m };   // no SPD
        L[i * w + m] = Math.sqrt(s);
      } else {
        L[i * w + (j - i + m)] = s / L[j * w + m];
      }
    }
  }
  return { ok: true, L, w, m, perm, n };
}

// Resuelve K·x = b usando un factor de bandFactor. Devuelve Float64Array(n).
export function bandSolve(F, b, out) {
  const { L, w, m, perm, n } = F;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[perm[i]];
    const j0 = i - m < 0 ? 0 : i - m;
    for (let j = j0; j < i; j++) s -= L[i * w + (j - i + m)] * y[j];
    y[i] = s / L[i * w + m];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    const jmax = i + m > n - 1 ? n - 1 : i + m;
    for (let j = i + 1; j <= jmax; j++) s -= L[j * w + (i - j + m)] * x[j];
    x[i] = s / L[i * w + m];
  }
  const u = out || new Float64Array(n);
  for (let i = 0; i < n; i++) u[perm[i]] = x[i];
  return u;
}

// ── Cholesky DENSA (exploración académica) ──────────────────────────────────
// Factorización completa O(n³) sobre la matriz densa, sin reordenar ni comprimir:
// más lenta, pero transparente (la matriz de rigidez se usa tal cual). { ok, L, n }.
export function denseFactor(Kff, n) {
  const L = new Float64Array(n * n);   // triangular inferior
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = Kff[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 0 || !isFinite(s)) return { ok: false };
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  return { ok: true, L, n };
}
export function denseSolve(F, b, out) {
  const { L, n } = F;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; const off = i * n; for (let j = 0; j < i; j++) s -= L[off + j] * y[j]; y[i] = s / L[off + i]; }
  const x = out || new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let j = i + 1; j < n; j++) s -= L[j * n + i] * x[j]; x[i] = s / L[i * n + i]; }
  return x;
}

// Selector: factoriza Kff con el método elegido y devuelve { ok, solve(b,out), kind, m }.
//   dense=false (por defecto) → Cholesky en banda (rápida). dense=true → densa.
export function makeFactor(Kff, n, dense = false, perm = null) {
  if (dense) {
    const f = denseFactor(Kff, n);
    if (!f.ok) return { ok: false, kind: 'densa' };
    return { ok: true, kind: 'densa', m: n, solve: (b, out) => denseSolve(f, b, out) };
  }
  const f = bandFactor(Kff, n, perm);
  if (!f.ok) return { ok: false, kind: 'banda' };
  return { ok: true, kind: 'banda', m: f.m, solve: (b, out) => bandSolve(f, b, out) };
}

// Extensión por filas de la sparsity (banda variable): lo[i]/hi[i] = primera y
// última columna no nula de la fila i. Permite productos matriz·vector en O(n·b).
export function rowBands(K, n) {
  const lo = new Int32Array(n), hi = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const off = i * n; let a = i, b = i;
    for (let j = 0; j < n; j++) if (K[off + j] !== 0) { if (j < a) a = j; if (j > b) b = j; }
    lo[i] = a; hi[i] = b;
  }
  return { lo, hi };
}

// Factoriza Kff (densa, SPD) con RCM + Cholesky en banda y resuelve cada RHS de
// rhsList. Devuelve { ok, uList:[Float64Array], bandwidth }.
export function factorSolveMany(Kff, n, rhsList) {
  if (n === 0) return { ok: true, uList: rhsList.map(() => new Float64Array(0)), bandwidth: 0 };
  const F = bandFactor(Kff, n);
  if (!F.ok) return { ok: false, bandwidth: F.m };
  const uList = rhsList.map(b => bandSolve(F, b));
  return { ok: true, uList, bandwidth: F.m };
}
