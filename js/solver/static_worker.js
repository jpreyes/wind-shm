// ──────────────────────────────────────────────────────────────────────────────
// static_worker.js — resuelve K·u = F para TODOS los casos estáticos fuera del
// hilo principal (la UI no se congela). Module worker (importa linsolve.js ESM).
//
//   Main → Worker: { Kflat: Float64Array(nDOF²), nDOF, freeDOF: Int32Array, Flist: [Float64Array(nDOF)] }
//   Worker → Main: { progress, done, total }   (avance)
//                  { ok:true, uList, reactionsList, bandwidth }   (éxito)
//                  { ok:false, error? }   (no SPD / inestable → el main usa respaldo)
//
// Estrategia: extrae K_ff, factoriza UNA vez (Cholesky en banda con RCM) y
// resuelve cada lado derecho. Reacciones = K·u − F (en el worker, no bloquea).
// ──────────────────────────────────────────────────────────────────────────────
import { makeFactor, makeFactorCSR } from './linsolve.js?v=119';

self.onmessage = (e) => {
  // Camino DISPERSO: llega K_ff en CSR + acoplamiento fijo–libre (cf). No se
  // materializa la matriz densa en ningún momento.
  if (e.data && e.data.csr) { _solveSparse(e.data); return; }

  const { Kflat, nDOF, freeDOF, Flist, dense } = e.data;
  try {
    const nF = freeDOF.length;
    if (nF === 0) { self.postMessage({ ok: false, error: 'sin GDL libres' }); return; }

    // Extraer K_ff (libre–libre)
    const Kff = new Float64Array(nF * nF);
    for (let i = 0; i < nF; i++) {
      const rowK = freeDOF[i] * nDOF, rowF = i * nF;
      for (let j = 0; j < nF; j++) Kff[rowF + j] = Kflat[rowK + freeDOF[j]];
    }
    // Reducir cada F a los GDL libres
    const FfList = Flist.map(F => { const ff = new Float64Array(nF); for (let i = 0; i < nF; i++) ff[i] = F[freeDOF[i]]; return ff; });

    self.postMessage({ progress: 'factorizando', done: 0, total: Flist.length });
    const fac = makeFactor(Kff, nF, !!dense);   // densa (académica) o banda (rápida)
    if (!fac.ok) { self.postMessage({ ok: false }); return; }   // no SPD → respaldo en el main

    const uList = [], reactionsList = [];
    for (let c = 0; c < Flist.length; c++) {
      const uf = fac.solve(FfList[c]);
      const u = new Float64Array(nDOF);
      for (let i = 0; i < nF; i++) u[freeDOF[i]] = uf[i];
      // reacciones = K·u − F
      const F = Flist[c];
      const reac = new Float64Array(nDOF);
      for (let i = 0; i < nDOF; i++) {
        let s = 0; const off = i * nDOF;
        for (let j = 0; j < nDOF; j++) s += Kflat[off + j] * u[j];
        reac[i] = s - F[i];
      }
      uList.push(u); reactionsList.push(reac);
      self.postMessage({ progress: 'resolviendo', done: c + 1, total: Flist.length });
    }
    self.postMessage({ ok: true, uList, reactionsList, bandwidth: fac.m, kind: fac.kind });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};

// ── Resolución por el camino DISPERSO ─────────────────────────────────────────
//   { csr:{n,rowPtr,colIdx,val}, cf:{rowDof,ptr,freeIdx,val}, nDOF, freeDOF, Flist }
function _solveSparse(data) {
  const { csr, cf, nDOF, freeDOF, Flist } = data;
  try {
    const nF = freeDOF.length;
    if (nF === 0) { self.postMessage({ ok: false, error: 'sin GDL libres' }); return; }

    self.postMessage({ progress: 'factorizando', done: 0, total: Flist.length });
    const fac = makeFactorCSR(csr);     // RCM + Cholesky en banda, sin densificar
    if (!fac.ok) { self.postMessage({ ok: false }); return; }   // no SPD → respaldo en el main

    const uList = [], reactionsList = [];
    for (let c = 0; c < Flist.length; c++) {
      const F = Flist[c];
      const Ff = new Float64Array(nF);
      for (let i = 0; i < nF; i++) Ff[i] = F[freeDOF[i]];
      const uf = fac.solve(Ff);

      const u = new Float64Array(nDOF);
      for (let i = 0; i < nF; i++) u[freeDOF[i]] = uf[i];

      // Reacciones SOLO en GDL fijos con acoplamiento: reac = K[fijo,libre]·u_f − F
      const reac = new Float64Array(nDOF);
      const { rowDof, ptr, freeIdx, val } = cf;
      for (let r = 0; r < rowDof.length; r++) {
        let s = 0;
        for (let p = ptr[r]; p < ptr[r + 1]; p++) s += val[p] * uf[freeIdx[p]];
        reac[rowDof[r]] = s - F[rowDof[r]];
      }

      uList.push(u); reactionsList.push(reac);
      self.postMessage({ progress: 'resolviendo', done: c + 1, total: Flist.length });
    }
    self.postMessage({ ok: true, uList, reactionsList, bandwidth: fac.m, kind: 'banda·dispersa' });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
}
