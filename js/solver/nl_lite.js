// ──────────────────────────────────────────────────────────────────────────────
// nl_lite.js — Análisis NO LINEAL geométrico «lite» (accesible para todos).
//
// FASE 1:
//   · Elemento BARRA/CABLE corotacional 3D (no linealidad geométrica exacta).
//   · Cable «tension-only»: si entra en compresión queda flojo (N = 0).
//   · Pretensado por LONGITUD NATURAL L0 (si L0 < longitud geométrica → tracción
//     en reposo; el equilibrio inicial ya incluye la pretensión).
//   · Solver INCREMENTAL-ITERATIVO (Newton-Raphson) con control de carga.
//   · Registro paso a paso de la deformada (para animación).
//
// El núcleo es AUTÓNOMO (su propio solver lineal denso) para poder verificarlo
// en Node sin dependencias y como base de las fases siguientes (P-Delta, pandeo,
// form-finding, rótulas plásticas, control de desplazamiento).
//
// Convención: 3 GDL de traslación por nodo. X = coords de referencia
// (Float64Array 3·nNode). u = desplazamientos (mismo tamaño). dof global = 3·nodo+c.
// ──────────────────────────────────────────────────────────────────────────────

// ── Solver lineal denso (Gauss con pivoteo parcial) ───────────────────────────
export function solveDense(A, b, n) {
  const M = new Float64Array(n * n); M.set(A);
  const x = new Float64Array(n); x.set(b);
  for (let k = 0; k < n; k++) {
    // pivoteo parcial
    let p = k, mx = Math.abs(M[k * n + k]);
    for (let i = k + 1; i < n; i++) { const v = Math.abs(M[i * n + k]); if (v > mx) { mx = v; p = i; } }
    if (mx < 1e-300) return null;   // singular
    if (p !== k) {
      for (let j = 0; j < n; j++) { const t = M[k * n + j]; M[k * n + j] = M[p * n + j]; M[p * n + j] = t; }
      const t = x[k]; x[k] = x[p]; x[p] = t;
    }
    const piv = M[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = M[i * n + k] / piv;
      if (f === 0) continue;
      for (let j = k; j < n; j++) M[i * n + j] -= f * M[k * n + j];
      x[i] -= f * x[k];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= M[i * n + j] * x[j];
    x[i] = s / M[i * n + i];
  }
  return x;
}

// ── Estado corotacional de un elemento barra/cable ────────────────────────────
// Devuelve N (axial), l (longitud actual), n (vector unitario i→j), taut (bool).
// slack = rigidez axial residual relativa cuando el cable está flojo (estabiliza
// el tangente sin alterar el equilibrio porque N=0).
export function barState(X, u, el) {
  const i = el.n1, j = el.n2;
  const xi = X[3 * i] + u[3 * i], yi = X[3 * i + 1] + u[3 * i + 1], zi = X[3 * i + 2] + u[3 * i + 2];
  const xj = X[3 * j] + u[3 * j], yj = X[3 * j + 1] + u[3 * j + 1], zj = X[3 * j + 2] + u[3 * j + 2];
  let dx = xj - xi, dy = yj - yi, dz = zj - zi;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-300;
  const n = [dx / l, dy / l, dz / l];
  const L0 = el.L0;
  let N = el.EA * (l - L0) / L0;       // fuerza axial (engineering strain)
  let taut = true;
  if (el.cable && N < 0) { N = 0; taut = false; }   // cable flojo → sin fuerza
  return { N, l, n, L0, taut };
}

// Fuerza interna nodal g (6) y tangente kt (6×6) del elemento, en orden
// [i_x,i_y,i_z, j_x,j_y,j_z]. g = ∂U/∂u, kt = ∂g/∂u.
export function barForceTangent(X, u, el, slack = 1e-6) {
  const st = barState(X, u, el);
  const { N, l, n, L0, taut } = st;
  const EAeff = taut ? el.EA : el.EA * slack;     // cable flojo: rigidez residual
  const km = EAeff / L0;                           // coef material
  const kg = l > 0 ? N / l : 0;                    // coef geométrico

  // bloque 3×3  K = km·nnᵀ + kg·(I − nnᵀ)
  const K = new Float64Array(9);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const nn = n[a] * n[b];
    K[a * 3 + b] = km * nn + kg * ((a === b ? 1 : 0) - nn);
  }
  // kt = [[K,−K],[−K,K]]
  const kt = new Float64Array(36);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const v = K[a * 3 + b];
    kt[a * 6 + b] = v; kt[a * 6 + (b + 3)] = -v;
    kt[(a + 3) * 6 + b] = -v; kt[(a + 3) * 6 + (b + 3)] = v;
  }
  // g_i = −N·n , g_j = +N·n
  const g = new Float64Array(6);
  for (let a = 0; a < 3; a++) { g[a] = -N * n[a]; g[a + 3] = N * n[a]; }
  return { g, kt, N, l, taut };
}

// ── Ensamblaje de la fuerza interna global y el tangente (sobre GDL libres) ────
// dofMap: Int32Array(3·nNode) con índice libre 0..nF−1 o −1 si está fijo.
function assembleNL(X, u, elems, dofMap, nF, slack) {
  const Fint = new Float64Array(nF);
  const Kt = new Float64Array(nF * nF);
  const Ndata = new Array(elems.length);
  for (let e = 0; e < elems.length; e++) {
    const el = elems[e];
    const { g, kt, N, taut } = barForceTangent(X, u, el, slack);
    Ndata[e] = { N, taut };
    const gd = [3 * el.n1, 3 * el.n1 + 1, 3 * el.n1 + 2, 3 * el.n2, 3 * el.n2 + 1, 3 * el.n2 + 2];
    for (let a = 0; a < 6; a++) {
      const fa = dofMap[gd[a]]; if (fa < 0) continue;
      Fint[fa] += g[a];
      for (let b = 0; b < 6; b++) {
        const fb = dofMap[gd[b]]; if (fb < 0) continue;
        Kt[fa * nF + fb] += kt[a * 6 + b];
      }
    }
  }
  return { Fint, Kt, Ndata };
}

// ── Solver no lineal incremental-iterativo (Newton-Raphson, control de carga) ──
/**
 * @param {object} o
 *   X       Float64Array(3·nNode)  coords de referencia
 *   u0      Float64Array(3·nNode)  desplazamiento inicial (opcional, def. 0)
 *   elems   [{n1,n2,EA,L0,cable}]   elementos barra/cable
 *   free    Int32Array | number[]   GDL globales libres (3·nodo+c)
 *   Fref    Float64Array(3·nNode)   carga externa de referencia (a λ=1)
 *   nSteps  nº de incrementos de carga (def. 10)
 *   maxIter iteraciones Newton por paso (def. 50)
 *   tol     tolerancia de residuo relativo (def. 1e-8)
 *   slack   rigidez residual de cable flojo (def. 1e-6)
 * @returns { converged, steps:[{lambda,u,N,iters,resid}], reactions, nF }
 */
export function solveNonlinear(o) {
  const X = o.X;
  const nNode = X.length / 3;
  const nDOF = nNode * 3;
  const elems = o.elems;
  const nSteps = o.nSteps || 10;
  const maxIter = o.maxIter || 50;
  const tol = o.tol ?? 1e-8;
  const slack = o.slack ?? 1e-6;

  const dofMap = new Int32Array(nDOF).fill(-1);
  let nF = 0;
  for (const d of o.free) dofMap[d] = nF++;

  const Fref = o.Fref || new Float64Array(nDOF);
  const FrefF = new Float64Array(nF);
  for (let d = 0; d < nDOF; d++) if (dofMap[d] >= 0) FrefF[dofMap[d]] = Fref[d];

  const u = o.u0 ? Float64Array.from(o.u0) : new Float64Array(nDOF);
  const steps = [];
  let converged = true;

  for (let s = 1; s <= nSteps; s++) {
    const lambda = s / nSteps;
    let it = 0, resid = Infinity, ok = false;
    for (; it < maxIter; it++) {
      const { Fint, Kt } = assembleNL(X, u, elems, dofMap, nF, slack);
      // residuo r = λ·Fref − Fint   (en GDL libres)
      const r = new Float64Array(nF);
      let rn = 0, fn = 0;
      for (let i = 0; i < nF; i++) { r[i] = lambda * FrefF[i] - Fint[i]; rn += r[i] * r[i]; fn += (lambda * FrefF[i]) ** 2; }
      rn = Math.sqrt(rn); fn = Math.sqrt(fn) || 1;
      resid = rn / fn;
      if (resid < tol) { ok = true; break; }
      const du = solveDense(Kt, r, nF);
      if (!du) { ok = false; break; }   // tangente singular → mecanismo
      for (let i = 0; i < nDOF; i++) { const fi = dofMap[i]; if (fi >= 0) u[i] += du[fi]; }
    }
    const { Ndata } = assembleNL(X, u, elems, dofMap, nF, slack);
    steps.push({ lambda, u: Float64Array.from(u), N: Ndata.map(d => d.N), taut: Ndata.map(d => d.taut), iters: it + 1, resid });
    if (!ok) { converged = false; break; }
  }

  // Reacciones: en los GDL fijos, R = Fint(fijo) − Fext(fijo)
  const { Fint: FintAll } = assembleNLfull(X, u, elems, nDOF, slack);
  const reactions = new Float64Array(nDOF);
  for (let d = 0; d < nDOF; d++) if (dofMap[d] < 0) reactions[d] = FintAll[d] - (Fref[d] || 0);

  return { converged, steps, reactions, nF, u };
}

// Fuerza interna en TODOS los GDL (para reacciones).
function assembleNLfull(X, u, elems, nDOF, slack) {
  const Fint = new Float64Array(nDOF);
  for (const el of elems) {
    const { g } = barForceTangent(X, u, el, slack);
    const gd = [3 * el.n1, 3 * el.n1 + 1, 3 * el.n1 + 2, 3 * el.n2, 3 * el.n2 + 1, 3 * el.n2 + 2];
    for (let a = 0; a < 6; a++) Fint[gd[a]] += g[a];
  }
  return { Fint };
}
