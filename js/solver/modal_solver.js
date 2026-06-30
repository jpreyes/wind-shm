// ──────────────────────────────────────────────────────────────────────────────
// ModalSolver — Stodola inverse power iteration with M-orthogonal deflation
//
// Finds the first nModes natural modes of  K·φ = ω²·M·φ  without computing
// the full eigendecomposition of A = M⁻¹K.
//
// Why not numeric.eig?
//   The penalty method for rigid diaphragms makes K ill-conditioned
//   (condition ~ 1e8), causing numeric.eig to produce undefined eigenvector
//   rows for large matrices.  Inverse power iteration avoids this because:
//   · It only uses numeric.LU + LUsolve (stable direct factorisation).
//   · It naturally finds low-frequency structural modes first, skipping the
//     high-frequency penalty modes entirely.
//
// Algorithm per mode i:
//   1. Start: random vector x₀, M-normalised, M-orthogonal to found modes.
//   2. Inverse power step:  solve K·y = M·x   →   y ≈ φᵢ / ωᵢ²
//   3. M-orthogonalise y against found modes (deflation).
//   4. Update x ← y / ‖y‖_M ,  Rayleigh quotient ωᵢ² = xᵀKx.
//   5. Repeat until ‖Δω²‖/ω² < 1e-7.
// ──────────────────────────────────────────────────────────────────────────────
import { buildNodeIndex, assembleK, getNodeDOFs } from './assembler.js?v=246';
import { ModalResults } from './modal_results.js?v=246';

export class ModalSolver {
  /**
   * @param {Model}  model
   * @param {number} nModes   number of modes to extract (default 10)
   */
  solve(model, nModes = 10) {
    const nodeIndex = buildNodeIndex(model);
    const { K, M, nDOF } = assembleK(model, nodeIndex);

    // ── Free DOFs ─────────────────────────────────────────────────────────────
    const freeDOF = [];
    for (const node of model.nodes.values()) {
      const d = getNodeDOFs(nodeIndex, node.id);
      const r = node.restraints;
      [r.ux, r.uy, r.uz, r.rx, r.ry, r.rz].forEach((fixed, li) => {
        if (!fixed) freeDOF.push(d[li]);
      });
    }
    if (freeDOF.length === 0) throw new Error('No hay grados de libertad libres.');

    const nF = freeDOF.length;

    // ── Extract K_ff and M_ff ─────────────────────────────────────────────────
    const Kff = Array.from({length: nF}, (_, i) =>
      Array.from({length: nF}, (_, j) => K[freeDOF[i]*nDOF + freeDOF[j]])
    );
    const Mff = Array.from({length: nF}, (_, i) =>
      Array.from({length: nF}, (_, j) => M[freeDOF[i]*nDOF + freeDOF[j]])
    );

    // ── Check that model has mass ─────────────────────────────────────────────
    let maxMd = 0;
    for (let i = 0; i < nF; i++) maxMd = Math.max(maxMd, Math.abs(Mff[i][i]));
    if (maxMd < 1e-30)
      throw new Error(
        'Matriz de masas nula. Asigne densidad ρ a los materiales ' +
        'o masa a los diafragmas.'
      );
    const eps = maxMd * 1e-8;
    for (let i = 0; i < nF; i++) {
      if (Math.abs(Mff[i][i]) < eps) Mff[i][i] = eps;
    }

    const num = window.numeric;
    if (!num) throw new Error('numeric.js no disponible.');

    // ── Pre-factor Kff once (reused across all inverse power steps) ───────────
    let KLU;
    try { KLU = num.LU(Kff); } catch(e) {
      throw new Error('Factorización de K falló: ' + e.message +
                      '.  Verifique estabilidad del modelo.');
    }

    // ── Stodola inverse power iteration ──────────────────────────────────────
    const modes = _stodola(Kff, KLU, Mff, nF, nModes, num);

    if (modes.length === 0)
      throw new Error(
        'Sin modos estructurales. Verifique masa (ρ en material o diafragmas) y apoyos.'
      );

    return new ModalResults(model, nodeIndex, freeDOF, modes, M, nDOF);
  }
}

// ── Stodola with M-orthogonal deflation ───────────────────────────────────────
function _stodola(K, KLU, M, nF, nModes, num) {
  const found = [];

  for (let modeNum = 0; modeNum < nModes; modeNum++) {
    let bestOmega2 = Infinity, bestVec = null;

    // Try up to 6 different start vectors per mode to survive M-deflation degeneracy
    for (let attempt = 0; attempt < 6; attempt++) {
      // Deterministic but different seeds per attempt
      const phase = (modeNum + 1 + attempt * 7) * 0.7 + attempt * 0.41;
      let x = Array.from({length: nF}, (_, i) =>
        Math.sin(phase * (i + 1)) + Math.cos((attempt + 1) * (i + 0.5) * 1.1) * 0.5 + 0.1
      );
      _mOrtho(x, found, M, nF);

      // Skip if near-zero after M-deflation (start vector ≈ span of found modes)
      const Mx0 = _mv(M, x, nF);
      const n0  = Math.sqrt(Math.max(_dot(x, Mx0, nF), 0));
      if (n0 < 1e-10) continue;

      x = _mNorm(x, M, nF);

      let omega2 = 0, converged = false;

      for (let iter = 0; iter < 150; iter++) {
        const Mx = _mv(M, x, nF);
        const y  = num.LUsolve(KLU, Mx);

        _mOrtho(y, found, M, nF);

        // Abort if deflated vector is trivial
        const My  = _mv(M, y, nF);
        const yn  = Math.sqrt(Math.max(_dot(y, My, nF), 0));
        if (yn < 1e-30) break;

        const xNew = _mNorm([...y], M, nF);
        const Kx   = _mv(K, xNew, nF);
        const w2   = _dot(xNew, Kx, nF);

        if (!isFinite(w2) || w2 < 0) break;

        const relChange = Math.abs(w2 - omega2) / Math.max(w2, 1e-10);
        omega2 = w2;
        x      = xNew;

        if (relChange < 1e-7 && iter >= 4) { converged = true; break; }
        // Fallback: accept near-converged result for ill-conditioned penalty systems
        if (relChange < 1e-4 && iter >= 20) { converged = true; break; }
      }

      if (converged && isFinite(omega2) && omega2 >= 0 && omega2 < 1e12) {
        // Keep the attempt that gives the smallest ω² (lowest frequency)
        if (omega2 < bestOmega2) { bestOmega2 = omega2; bestVec = [...x]; }
      }
    }

    if (!bestVec) break;   // none of the attempts converged → stop
    found.push({ omega2: bestOmega2, vec: bestVec });
  }

  return found;
}

// ── Dense matrix / vector helpers ─────────────────────────────────────────────
function _mv(A, x, n) {
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const Ai = A[i];
    let s = 0;
    for (let j = 0; j < n; j++) s += Ai[j] * x[j];
    y[i] = s;
  }
  return y;
}

function _dot(a, b, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function _mNorm(x, M, n) {
  const Mx   = _mv(M, x, n);
  const norm = Math.sqrt(Math.max(_dot(x, Mx, n), 0));
  if (norm < 1e-30) return x;
  for (let i = 0; i < n; i++) x[i] /= norm;
  return x;
}

function _mOrtho(x, found, M, n) {
  for (const { vec: phi } of found) {
    const Mphi = _mv(M, phi, n);
    const c    = _dot(x, Mphi, n);   // xᵀ M φ
    for (let i = 0; i < n; i++) x[i] -= c * phi[i];
  }
}
