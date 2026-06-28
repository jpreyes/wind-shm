// ──────────────────────────────────────────────────────────────────────────────
// nl_worker.js — Solvers NO LINEALES «lite» (Newton corotacional) fuera del hilo
// principal, igual que modal_worker.js / buckling_worker.js. Evita que la UI se
// congele en modelos grandes: el núcleo de `nl_lite.js` usa un solver DENSO
// (`solveDense` O(n³)) por cada iteración de Newton × pasos de carga (#44).
//
// Protocolo:
//   Main → Worker: { kind: 'nl' | 'dc', opts }
//     'nl' → solveNonlinear(opts)      (control de carga; No lineal)
//     'dc' → solveNonlinearDC(opts)    (control de desplazamiento; Pushover)
//   Worker → Main: { res }  |  { error }
//
// `opts` (X, Fref, elems, free…) y el resultado (steps/path con Float64Array)
// viajan por clonado estructurado, que preserva los typed arrays.
// ──────────────────────────────────────────────────────────────────────────────
import { solveNonlinear, solveNonlinearDC } from './nl_lite.js?v=211';

self.onmessage = (e) => {
  const { kind, opts } = e.data;
  try {
    const res = kind === 'dc' ? solveNonlinearDC(opts) : solveNonlinear(opts);
    self.postMessage({ res });
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
