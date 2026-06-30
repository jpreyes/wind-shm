// ──────────────────────────────────────────────────────────────────────────────
// StaticSolver — direct stiffness method for linear static analysis
// Solver:  K_ff · u_f = F_f  (Gaussian elimination via numeric.js)
// ──────────────────────────────────────────────────────────────────────────────
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from './assembler.js?v=230';
import { Results } from './postprocess.js?v=230';

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

    // Modelo 2D (pórtico plano X–Z): los GDL fuera del plano (uy, rx, rz) se
    // restringen automáticamente en todos los nodos — el usuario solo maneja
    // los GDL del plano: ux, uz y el giro ry.
    const is2D = model.mode === '2D';

    // Desplazamiento prescrito (#54): valor impuesto por GDL restringido.
    // up[gi] = desplazamiento conocido del GDL soporte (0 = apoyo normal).
    const up = new Float64Array(nDOF);
    let hasPresc = false;
    const dofNames = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];

    for (const node of model.nodes.values()) {
      const d    = getNodeDOFs(nodeIndex, node.id);
      const r    = node.restraints;
      const pd   = node.prescDisp;
      const rArr = [
        r.ux,
        is2D ? 1 : r.uy,
        r.uz,
        is2D ? 1 : r.rx,
        r.ry,
        is2D ? 1 : r.rz,
      ];
      d.forEach((gi, li) => {
        const pv = pd ? (+pd[dofNames[li]] || 0) : 0;   // valor prescrito de este GDL
        if (rArr[li] || pv !== 0) {
          fixedDOF.push(gi);
          if (pv !== 0) { up[gi] = pv; hasPresc = true; }
        } else {
          freeDOF.push(gi);
        }
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
    // F_f efectivo = F_f − K_fp·u_p   (traslada el desplazamiento prescrito al RHS)
    const Ff = freeDOF.map((di, i) => {
      let f = F[di];
      if (hasPresc) for (const dj of fixedDOF) { if (up[dj]) f -= K[di * nDOF + dj] * up[dj]; }
      return f;
    });

    // ── Solve ─────────────────────────────────────────────────────────────
    const num = window.numeric;
    if (!num) throw new Error('numeric.js no está disponible');

    let uf;
    try {
      uf = num.solve(Kff, Ff);
    } catch (e) {
      throw new Error(`Solver falló: ${e.message}. Verifique que el modelo es estable.`);
    }

    // numeric.solve devuelve NaN/Infinity silenciosamente si K_ff es singular
    // (mecanismo por liberaciones excesivas o apoyos insuficientes)
    if (!uf || uf.some(v => !Number.isFinite(v))) {
      throw new Error(
        'Estructura INESTABLE (matriz singular): existe un mecanismo. ' +
        'Revise apoyos y liberaciones — p.ej. liberar el mismo giro en ambos ' +
        'extremos de elementos contiguos permite rotación libre.'
      );
    }

    // ── Assemble full displacement vector ──────────────────────────────────
    const u = new Float64Array(nDOF);
    freeDOF.forEach((d, i) => { u[d] = uf[i]; });
    if (hasPresc) for (const d of fixedDOF) if (up[d]) u[d] = up[d];   // GDL prescritos (#54)

    // ── Compute reactions ──────────────────────────────────────────────────
    const reactions = new Float64Array(nDOF);
    for (let i = 0; i < nDOF; i++) {
      let Ku_i = 0;
      for (let j = 0; j < nDOF; j++) Ku_i += K[i * nDOF + j] * u[j];
      reactions[i] = Ku_i - F[i];
    }

    // Reacciones de apoyos elásticos: SOLO en GDL libres (donde el resorte es el
    // apoyo). Ahí el balance Ku−F vale 0 y la reacción real es −k·u. Si el GDL
    // también está rígidamente restringido, el resorte no actúa (u=0): se conserva
    // la reacción rígida Ku−F y NO se sobrescribe (de lo contrario daría 0).
    const freeSet = new Set(freeDOF);
    for (const node of model.nodes.values()) {
      const sp = node.springs;
      if (!sp) continue;
      const ks = [sp.kux, sp.kuy, sp.kuz, sp.krx, sp.kry, sp.krz];
      if (!ks.some(k => k > 0)) continue;
      const d = getNodeDOFs(nodeIndex, node.id);
      for (let i = 0; i < 6; i++) {
        if (ks[i] > 0 && freeSet.has(d[i])) reactions[d[i]] = -ks[i] * u[d[i]];
      }
    }

    return new Results(model, nodeIndex, u, reactions, F, lcId, selfWeight);
  }
}


// ── Default load case manager helper ─────────────────────────────────────────
export function ensureDefaultLC(model) {
  // CM (carga muerta) incluye el peso propio por defecto
  if (model.loadCases.size === 0) model.addLoadCase('CM', true);
  return model.loadCases.keys().next().value;
}

