// runners.mjs — corre los solvers de Pórtico HEADLESS (Node), reusando el código
// real de la app. numeric.js se carga como global (shim de window) una sola vez.
import { ModalSolver } from '../../js/solver/modal_solver.js';
import { StaticSolver } from '../../js/solver/static_solver.js';

let _num = false;
export async function ensureNumeric() {
  if (_num) return;
  globalThis.window = globalThis;
  await import('../../lib/numeric.js');           // define `numeric` global
  globalThis.window.numeric = globalThis.numeric;
  _num = true;
}

// En modelos 2D la app (runModal) restringe uy/rx/rz; ModalSolver usa los
// restraints del nodo tal cual, así que replicamos esa restricción aquí.
function apply2D(model) {
  if (model.mode !== '2D') return;
  for (const n of model.nodes.values()) { n.restraints.uy = 1; n.restraints.rx = 1; n.restraints.rz = 1; }
}

// Análisis modal — devuelve el ModalResults real (period[], freq[], getModeShape…).
export async function runModal(model, nModes = 6) {
  await ensureNumeric();
  apply2D(model);
  return new ModalSolver().solve(model, nModes);
}

// Análisis estático lineal — devuelve el Results real (getNodeDisp, esfuerzos…).
export async function runStatic(model, lcId = null, selfWeight = false) {
  await ensureNumeric();
  apply2D(model);
  return new StaticSolver().solve(model, lcId, selfWeight);
}

// Despacho por tipo de análisis (se irá ampliando: buckling, espectro, …).
export async function runAnalysis(model, spec) {
  switch (spec.analysis) {
    case 'modal': return { type: 'modal', res: await runModal(model, spec.nModes || 6) };
    case 'static': return { type: 'static', res: await runStatic(model, spec.lcId ?? null, !!spec.selfWeight) };
    default: throw new Error('Análisis no soportado en el harness: ' + spec.analysis);
  }
}
