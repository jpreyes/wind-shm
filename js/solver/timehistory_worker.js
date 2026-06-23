// ──────────────────────────────────────────────────────────────────────────────
// timehistory_worker.js — Integra las coordenadas modales qᵢ(t) del time-history
// fuera del hilo principal (#48a/#48d), igual que modal_worker/buckling_worker.
// La parte cara es la recurrencia SDOF por modo × pasos; la superposición espacial
// (u = Σ φᵢ qᵢ) la hace el hilo principal (barata) con las formas modales que ya
// tiene, así no hace falta enviar las φ al worker.
//
// Protocolo:
//   Main → Worker: { modes:[{omega, gamma}], ag:Float64Array, dt, zeta }
//   Worker → Main: { q:[Float64Array]·nModes, peakModal:Float64Array }  |  { error }
// ──────────────────────────────────────────────────────────────────────────────
import { sdofResponse } from './timehistory.js?v=169';

self.onmessage = (e) => {
  const { modes, ag, dt, zeta } = e.data;
  try {
    const nSteps = ag.length, nModes = modes.length;
    const zArr = Array.isArray(zeta) ? zeta : modes.map(() => (zeta ?? 0.05));
    const q = [];
    const peakModal = new Float64Array(nModes);
    for (let i = 0; i < nModes; i++) {
      const G = modes[i].gamma, p = new Float64Array(nSteps);
      for (let k = 0; k < nSteps; k++) p[k] = -G * ag[k];     // −Γ·a_g
      const { u } = sdofResponse(modes[i].omega, zArr[i], dt, p);
      q.push(u);
      let pk = 0; for (let k = 0; k < nSteps; k++) pk = Math.max(pk, Math.abs(u[k]));
      peakModal[i] = pk;
    }
    self.postMessage({ q, peakModal });
  } catch (err) {
    self.postMessage({ error: (err && err.message) ? err.message : String(err) });
  }
};
