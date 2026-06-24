// ──────────────────────────────────────────────────────────────────────────────
// buckling.js — PANDEO LINEAL por ITERACIÓN DE SUBESPACIO (Bathe), reusando el
// mismo motor que el análisis modal.
//
// Problema:  (K + λ·Kg)·φ = 0   ⇔   K·φ = λ·(−Kg)·φ
//   con K simétrica DEFINIDA POSITIVA (estructura estable) y Kg la rigidez
//   geométrica (indefinida; sólo las barras comprimidas reducen la rigidez).
//   λcr = factor crítico → carga de pandeo = λcr × carga de referencia.
//
// La iteración de subespacio sobre  X ← K⁻¹·(−Kg)·X  amplifica las componentes
// de MAYOR |1/λ|, es decir converge a los MENORES |λcr| (en bloque). En cada paso
// se reduce a Rayleigh-Ritz y se resuelve el problema pequeño q×q con `smallGenEig`,
// haciendo la reducción de Cholesky sobre Kᵣ = XᵀKX (que SÍ es SPD; −Kg no lo es).
// Como `smallGenEig(A,B)` resuelve A·v=ν·B·v con B SPD, llamamos
//   smallGenEig((−Kg)ᵣ, Kᵣ)  ⇒  ν = 1/λ.  El mayor |ν| ⇒ el menor |λcr|.
//
// AUTÓNOMO salvo por linsolve.js (factorización en banda) y subspace.js (núcleo
// compartido con el modal). Reutilizable en Node + browser + Worker.
// ──────────────────────────────────────────────────────────────────────────────
import { makeFactor, rowBands, permRCM } from './linsolve.js?v=201';
import { smallGenEig, mvBand, dot } from './subspace.js?v=201';

/**
 * @param {object} o
 *   Kff_flat   Float64Array(nF·nF)  rigidez elástica de los GDL libres (SPD)
 *   Kgff_flat  Float64Array(nF·nF)  rigidez geométrica de los GDL libres (Kg)
 *   nF         number               nº de GDL libres
 *   nModes     number               nº de modos de pandeo a extraer
 *   dense      boolean              true = Cholesky densa (sin reordenar)
 * @returns { modes:[{lambda, vec}] } | { error }
 *   vec en el orden ORIGINAL de los GDL libres (longitud nF).
 */
export function solveBuckling(o) {
  const { Kff_flat, Kgff_flat, nF, nModes, dense = false } = o;
  if (nF === 0) return { error: 'Sin GDL libres.' };
  const p = Math.max(1, Math.min(nModes, nF));

  // ── Reordenar K y −Kg a forma de banda (RCM sobre K) una sola vez ───────────
  // En banda la factorización, la resolución y los productos matriz·vector quedan
  // en O(n·b). Operamos en el espacio permutado; los modos se des-permutan al final.
  const negKg = new Float64Array(nF * nF);
  for (let i = 0; i < nF * nF; i++) negKg[i] = -Kgff_flat[i];

  let Kp = Kff_flat, Bp = negKg, perm = null, facPerm = null;
  if (!dense) {
    perm = permRCM(Kff_flat, nF);
    facPerm = new Int32Array(nF); for (let i = 0; i < nF; i++) facPerm[i] = i;
    Kp = new Float64Array(nF * nF); Bp = new Float64Array(nF * nF);
    for (let i = 0; i < nF; i++) {
      const pi = perm[i] * nF, oi = i * nF;
      for (let j = 0; j < nF; j++) { const pj = perm[j]; Kp[oi + j] = Kff_flat[pi + pj]; Bp[oi + j] = negKg[pi + pj]; }
    }
  }

  const fac = makeFactor(Kp, nF, !!dense, facPerm);
  if (!fac.ok) return { error: 'Factorización de K falló (¿estructura inestable / sin apoyos?).' };

  const KB = rowBands(Kp, nF), BB = rowBands(Bp, nF);
  const mvK = (x) => mvBand(Kp, x, nF, KB.lo, KB.hi);
  const mvB = (x) => mvBand(Bp, x, nF, BB.lo, BB.hi);   // producto con (−Kg)
  const solveK = (b) => fac.solve(b);

  const modes = _subspaceBuckling(mvK, mvB, solveK, nF, p);
  if (!modes.length) return { error: 'No se hallaron modos de pandeo (la carga de referencia no produce compresión). Revise su sentido.' };

  // Des-permutar los vectores al orden original
  if (perm) for (const md of modes) {
    const v = new Float64Array(nF); for (let i = 0; i < nF; i++) v[perm[i]] = md.vec[i]; md.vec = v;
  }
  return { modes };
}

// ── Iteración de subespacio para pandeo — extrae los p MENORES |λcr| en bloque ─
function _subspaceBuckling(mvK, mvB, solveK, nF, p) {
  const q = Math.min(nF, Math.max(p + 8, 2 * p));   // tamaño del subespacio
  // Semilla determinista (idéntica forma a la del modal)
  let X = [];
  for (let c = 0; c < q; c++) {
    const v = new Float64Array(nF);
    for (let i = 0; i < nF; i++) v[i] = Math.sin((c + 1) * 0.7 * (i + 1)) + 0.3 * Math.cos((c + 1) * (i + 0.5)) + (c === 0 ? 1 : 0);
    X.push(v);
  }

  let prevLam = null, lastModes = null;
  for (let iter = 0; iter < 60; iter++) {
    const Xb = X.map(col => solveK(mvB(col)));        // K⁻¹ (−Kg) X
    const KXb = Xb.map(col => mvK(col)), BXb = Xb.map(col => mvB(col));
    const Kr = [], Br = [];
    for (let a = 0; a < q; a++) {
      Kr.push(new Float64Array(q)); Br.push(new Float64Array(q));
      for (let b = 0; b < q; b++) { Kr[a][b] = dot(Xb[a], KXb[b], nF); Br[a][b] = dot(Xb[a], BXb[b], nF); }
    }
    // (−Kg)ᵣ·v = ν·Kᵣ·v, Kᵣ SPD ⇒ ν = 1/λ.  vals ascendente, vecs Kᵣ-ortonormales.
    const { vals: nu, vecs } = smallGenEig(Br, Kr, q);

    // Ordenar por |ν| DESCENDENTE (mayor |ν| = menor |λcr|, lo dominante de la iteración).
    const order = Array.from({ length: q }, (_, k) => k).sort((a, b) => Math.abs(nu[b]) - Math.abs(nu[a]));

    // Reconstruir el subespacio (todas las direcciones, reordenadas por dominancia).
    const Xnew = [];
    for (let c = 0; c < q; c++) {
      const k = order[c], v = new Float64Array(nF);
      for (let r = 0; r < q; r++) { const qc = vecs[k][r], xr = Xb[r]; if (qc) for (let i = 0; i < nF; i++) v[i] += qc * xr[i]; }
      Xnew.push(v);
    }
    X = Xnew;

    // Modos candidatos = los q en orden de dominancia, con λ = 1/ν.
    lastModes = order.map((k, c) => ({ lambda: nu[k] !== 0 ? 1 / nu[k] : Infinity, vec: X[c] }));

    // Convergencia sobre los |λ| de los p modos dominantes con ν finito ≠ 0.
    const lamP = lastModes.slice(0, p).map(m => m.lambda);
    if (prevLam) {
      let ok = true;
      for (let i = 0; i < p; i++) {
        const a = lamP[i], b = prevLam[i];
        if (!isFinite(a) || !isFinite(b)) continue;
        if (Math.abs(a - b) / Math.max(Math.abs(a), 1e-12) > 1e-6) { ok = false; break; }
      }
      if (ok && iter >= 2) break;
    }
    prevLam = lamP.slice();
  }

  // Filtrar λ > 0 (compresión → pandeo bajo la carga aplicada en su sentido),
  // finitos, y ordenar ascendente. Quedarse con los p primeros.
  return lastModes
    .filter(m => isFinite(m.lambda) && m.lambda > 1e-9)
    .sort((a, b) => a.lambda - b.lambda)
    .slice(0, p)
    .map(m => ({ lambda: m.lambda, vec: m.vec }));
}
