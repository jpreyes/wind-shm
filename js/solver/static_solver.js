// ──────────────────────────────────────────────────────────────────────────────
// StaticSolver — direct stiffness method for linear static analysis
// Solver:  K_ff · u_f = F_f  (Gaussian elimination via numeric.js)
// ──────────────────────────────────────────────────────────────────────────────
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from './assembler.js';
import { Results } from './postprocess.js?v=12';

export class StaticSolver {
  /**
   * @param {Model}       model
   * @param {number|null} lcId        Load case ID (null → pure self-weight)
   * @param {boolean}     selfWeight
   */
  solve(model, lcId = null, selfWeight = false) {
    // ── Build index & global matrices ─────────────────────────────────────
    const nodeIndex = buildNodeIndex(model);
    const { K, nDOF } = assembleK(model, nodeIndex);
    const F = assembleF(model, nodeIndex, lcId, selfWeight);

    // ── Classify DOFs ──────────────────────────────────────────────────────
    const freeDOF  = [];
    const fixedDOF = [];

    for (const node of model.nodes.values()) {
      const d    = getNodeDOFs(nodeIndex, node.id);
      const r    = node.restraints;
      const rArr = [r.ux, r.uy, r.uz, r.rx, r.ry, r.rz];
      d.forEach((gi, li) => {
        if (rArr[li]) fixedDOF.push(gi);
        else          freeDOF.push(gi);
      });
    }

    if (freeDOF.length === 0) {
      throw new Error('El modelo no tiene grados de libertad libres (¿todos los nodos están empotrados?)');
    }

    // ── Extract K_ff and F_f ──────────────────────────────────────────────
    const nF  = freeDOF.length;
    const Kff = Array.from({ length: nF }, (_, i) =>
      Array.from({ length: nF }, (_, j) => K[freeDOF[i] * nDOF + freeDOF[j]])
    );
    const Ff = freeDOF.map(d => F[d]);

    // ── Solve ─────────────────────────────────────────────────────────────
    const num = window.numeric;
    if (!num) throw new Error('numeric.js no está disponible');

    let uf;
    try {
      uf = num.solve(Kff, Ff);
    } catch (e) {
      throw new Error(`Solver falló: ${e.message}. Verifique que el modelo es estable.`);
    }

    // ── Assemble full displacement vector ──────────────────────────────────
    const u = new Float64Array(nDOF);
    freeDOF.forEach((d, i) => { u[d] = uf[i]; });

    // ── Compute reactions ──────────────────────────────────────────────────
    const reactions = new Float64Array(nDOF);
    for (let i = 0; i < nDOF; i++) {
      let Ku_i = 0;
      for (let j = 0; j < nDOF; j++) Ku_i += K[i * nDOF + j] * u[j];
      reactions[i] = Ku_i - F[i];
    }

    return new Results(model, nodeIndex, u, reactions, F, lcId, selfWeight);
  }
}


// ── Default load case manager helper ─────────────────────────────────────────
export function ensureDefaultLC(model) {
  if (model.loadCases.size === 0) model.addLoadCase('CM');
  return model.loadCases.keys().next().value;
}

