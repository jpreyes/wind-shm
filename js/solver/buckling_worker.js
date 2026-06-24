// ──────────────────────────────────────────────────────────────────────────────
// buckling_worker.js — PANDEO LINEAL por iteración de subespacio, fuera del hilo
// principal (igual que modal_worker.js para el modal). Evita el cuelgue del
// `numeric.eig` denso O(n³) en el hilo de UI.
//
// Protocolo:
//   Main → Worker: { Kff_flat, Kgff_flat, nF, nModes, dense }
//   Worker → Main: { modes: [{lambda, vec}] }  |  { error }
// ──────────────────────────────────────────────────────────────────────────────
import { solveBuckling } from './buckling.js?v=206';

self.onmessage = (e) => {
  const { Kff_flat, Kgff_flat, nF, nModes, dense } = e.data;
  try {
    const res = solveBuckling({ Kff_flat, Kgff_flat, nF, nModes, dense: !!dense });
    if (res.error) { self.postMessage({ error: res.error }); return; }
    // Float64Array → Array para postMessage estructurado
    self.postMessage({ modes: res.modes.map(m => ({ lambda: m.lambda, vec: Array.from(m.vec) })) });
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
