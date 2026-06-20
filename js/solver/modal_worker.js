// ──────────────────────────────────────────────────────────────────────────────
// modal_worker.js — iteración inversa de Stodola para el análisis modal, fuera
// del hilo principal. MODULE worker: usa el solver propio (Cholesky en banda con
// factorización única) en vez de numeric.js, y productos matriz·vector SOLO
// dentro de la banda (O(n·b) en vez de O(n²)). Mucho más rápido en modelos grandes.
//
// Protocolo:
//   Main → Worker: { Kff_flat, Mff_flat, nF, nModes, dense }
//   Worker → Main: { modes: [{omega2, vec}] }  |  { error }
// ──────────────────────────────────────────────────────────────────────────────
import { makeFactor, rowBands, permRCM } from './linsolve.js?v=87';

// Producto A·x usando la extensión por filas (banda variable) → O(n·b)
function _mvBand(A, x, n, lo, hi) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; const off = i * n, a = lo[i], b = hi[i];
    for (let j = a; j <= b; j++) s += A[off + j] * x[j];
    y[i] = s;
  }
  return y;
}
function _dot(a, b, n) { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }
function _mNorm(x, mvM, n) {
  const Mx = mvM(x);
  const norm = Math.sqrt(Math.max(_dot(x, Mx, n), 0));
  if (norm < 1e-30) return x;
  for (let i = 0; i < n; i++) x[i] /= norm;
  return x;
}
function _mOrtho(x, found, mvM, n) {
  for (const { vec: phi } of found) {
    const Mphi = mvM(phi);
    const c = _dot(x, Mphi, n);
    for (let i = 0; i < n; i++) x[i] -= c * phi[i];
  }
}

// Stodola con deflación M-ortogonal. solveK(b) resuelve K·y = b.
function _stodola(mvK, mvM, solveK, nF, nModes) {
  const found = [];
  for (let modeNum = 0; modeNum < nModes; modeNum++) {
    let bestOmega2 = Infinity, bestVec = null, lastConv = null, agree = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const phase = (modeNum + 1 + attempt * 7) * 0.7 + attempt * 0.41;
      let x = new Float64Array(nF);
      for (let i = 0; i < nF; i++) x[i] = Math.sin(phase * (i + 1)) + Math.cos((attempt + 1) * (i + 0.5) * 1.1) * 0.5 + 0.1;
      _mOrtho(x, found, mvM, nF);
      const n0 = Math.sqrt(Math.max(_dot(x, mvM(x), nF), 0));
      if (n0 < 1e-10) continue;
      _mNorm(x, mvM, nF);

      let omega2 = 0, converged = false;
      for (let iter = 0; iter < 150; iter++) {
        const Mx = mvM(x);
        const y = solveK(Mx);            // K y = M x
        _mOrtho(y, found, mvM, nF);
        const My = mvM(y);
        const yn = Math.sqrt(Math.max(_dot(y, My, nF), 0));
        if (yn < 1e-30) break;
        const xNew = y.slice();
        _mNorm(xNew, mvM, nF);
        const Kx = mvK(xNew);
        const w2 = _dot(xNew, Kx, nF);
        if (!isFinite(w2) || w2 < 0) break;
        const relChange = Math.abs(w2 - omega2) / Math.max(w2, 1e-10);
        omega2 = w2; x = xNew;
        if (relChange < 1e-7 && iter >= 4) { converged = true; break; }
        if (relChange < 1e-4 && iter >= 20) { converged = true; break; }
      }
      if (converged && isFinite(omega2) && omega2 >= 0 && omega2 < 1e12) {
        if (omega2 < bestOmega2) { bestOmega2 = omega2; bestVec = Array.from(x); }
        // salida temprana: dos intentos que convergen al MISMO ω² → suficiente
        if (lastConv !== null && Math.abs(omega2 - lastConv) / Math.max(omega2, 1e-12) < 1e-3) { agree++; }
        lastConv = omega2;
        if (agree >= 1) break;
      }
    }
    if (!bestVec) break;
    found.push({ omega2: bestOmega2, vec: new Float64Array(bestVec) });
  }
  return found.map(m => ({ omega2: m.omega2, vec: Array.from(m.vec) }));
}

self.onmessage = (e) => {
  const { Kff_flat, Mff_flat, nF, nModes, dense } = e.data;
  try {
    // Regularizar diagonal de M (masas nulas → mínimo positivo)
    let maxMd = 0;
    for (let i = 0; i < nF; i++) maxMd = Math.max(maxMd, Math.abs(Mff_flat[i * nF + i]));
    if (maxMd < 1e-30) { self.postMessage({ error: 'Matriz de masas nula. Asigne densidad ρ a los materiales o masa a los diafragmas.' }); return; }
    const eps = maxMd * 1e-8;
    for (let i = 0; i < nF; i++) if (Math.abs(Mff_flat[i * nF + i]) < eps) Mff_flat[i * nF + i] = eps;

    // REORDENAR K y M a forma de banda (RCM) una vez: así la factorización, la
    // resolución Y los productos matriz·vector quedan en O(n·b). En banda se opera
    // en el espacio permutado; los modos se des-permutan al final. En denso no
    // hace falta reordenar (se opera tal cual).
    let Kp = Kff_flat, Mp = Mff_flat, perm = null, facPerm = null;
    if (!dense) {
      perm = permRCM(Kff_flat, nF);
      facPerm = new Int32Array(nF); for (let i = 0; i < nF; i++) facPerm[i] = i;
      Kp = new Float64Array(nF * nF); Mp = new Float64Array(nF * nF);
      for (let i = 0; i < nF; i++) {
        const pi = perm[i] * nF, oi = i * nF;
        for (let j = 0; j < nF; j++) { const pj = perm[j]; Kp[oi + j] = Kff_flat[pi + pj]; Mp[oi + j] = Mff_flat[pi + pj]; }
      }
    }

    const fac = makeFactor(Kp, nF, !!dense, facPerm);
    if (!fac.ok) { self.postMessage({ error: 'Factorización de K falló (¿estructura inestable / sin apoyos?).' }); return; }

    // Productos matriz·vector solo dentro de la banda (de la matriz reordenada)
    const KB = rowBands(Kp, nF), MB = rowBands(Mp, nF);
    const mvK = (x) => _mvBand(Kp, x, nF, KB.lo, KB.hi);
    const mvM = (x) => _mvBand(Mp, x, nF, MB.lo, MB.hi);
    const solveK = (b) => fac.solve(b);

    const modes = _stodola(mvK, mvM, solveK, nF, nModes);
    if (!modes.length) { self.postMessage({ error: 'Sin modos estructurales. Verifique masa (ρ en material o diafragmas) y apoyos.' }); return; }
    // Des-permutar los vectores modales al orden original
    if (perm) for (const md of modes) {
      const v = new Float64Array(nF); for (let i = 0; i < nF; i++) v[perm[i]] = md.vec[i]; md.vec = Array.from(v);
    }
    self.postMessage({ modes });
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
