// ──────────────────────────────────────────────────────────────────────────────
// sparse.js — ensamblaje DISPERSO de la matriz de rigidez global.
//
// Replica EXACTAMENTE el ensamblaje denso (assembler.js + diaphragm.js) pero
// acumulando en un almacenamiento disperso (mapa por fila) en vez de un
// Float64Array n×n. Para modelos grandes esto evita la memoria O(nDOF²) y los
// barridos O(nDOF²): el ensamblaje, la extracción libre–libre, la factorización
// (Cholesky en banda) y los productos matriz·vector quedan en O(nnz).
//
// La salida es CSR (formato comprimido por filas) de K_ff (libre–libre), más un
// acoplamiento fijo–libre para calcular las reacciones, todo sin densificar.
// ──────────────────────────────────────────────────────────────────────────────
import {
  localAxes, stiffnessMatrix, massMatrix,
  transformMatrix, globalStiffness, applyReleases
} from './timoshenko.js?v=122';
import { applyDiaphragmConstraintsW, applyDiaphragmMassW } from './diaphragm.js?v=122';
import { assembleAreasInto, assembleAreasMassInto } from './membrane.js?v=122';

// ── Matriz simétrica dispersa (acumulador por filas) ──────────────────────────
export class SparseSym {
  constructor(n) {
    this.n = n;
    this.rows = Array.from({ length: n }, () => new Map());   // col → valor
  }
  add(i, j, v) {
    if (v === 0) return;
    const r = this.rows[i];
    r.set(j, (r.get(j) || 0) + v);
  }
  diag(i) { return this.rows[i].get(i) || 0; }
  // Interfaz «writer» que consume la lógica compartida de diaphragm.js
  writer() { return { add: (i, j, v) => this.add(i, j, v), diag: (i) => this.diag(i) }; }
}

// DOFs globales (0-based) de un nodo
function dofs(nodeIndex, nodeId) {
  const b = 6 * nodeIndex.get(nodeId);
  return [b, b + 1, b + 2, b + 3, b + 4, b + 5];
}

// ── Ensamblaje disperso de K (y opcionalmente M) sobre TODOS los GDL ──────────
// Devuelve { S, M, nDOF }. S y M son SparseSym (M=null si withMass=false).
export function assembleSparseGlobal(model, nodeIndex, { withMass = false } = {}) {
  const nDOF = nodeIndex.size * 6;
  const S = new SparseSym(nDOF);
  const M = withMass ? new SparseSym(nDOF) : null;

  for (const elem of model.elements.values()) {
    const n1  = model.nodes.get(elem.n1);
    const n2  = model.nodes.get(elem.n2);
    const mat = model.materials.get(elem.matId);
    const sec = model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) continue;

    const { ex, ey, ez, L } = localAxes(n1, n2);
    let Ke = stiffnessMatrix(L, mat, sec);
    const hasRelease = elem.releases?.some(r => r !== 0);
    if (hasRelease) Ke = applyReleases(Ke, elem.releases.map(r => r !== 0));

    const T  = transformMatrix(ex, ey, ez);
    const KG = globalStiffness(Ke, T);
    const ed = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++)
        S.add(ed[i], ed[j], KG[i][j]);

    if (withMass) {
      const MG = globalStiffness(massMatrix(L, mat, sec), T);
      for (let i = 0; i < 12; i++)
        for (let j = 0; j < 12; j++)
          M.add(ed[i], ed[j], MG[i][j]);
    }
  }

  // Apoyos elásticos (resortes) en la diagonal
  for (const node of model.nodes.values()) {
    const sp = node.springs;
    if (!sp) continue;
    const ks = [sp.kux, sp.kuy, sp.kuz, sp.krx, sp.kry, sp.krz];
    if (!ks.some(k => k > 0)) continue;
    const b = nodeIndex.get(node.id) * 6;
    for (let i = 0; i < 6; i++) if (ks[i] > 0) S.add(b + i, b + i, ks[i]);
  }

  // Elementos de área (membrana CST/QUAD) → GDL de traslación globales
  assembleAreasInto(S.writer(), model, nodeIndex);

  // Restricciones de diafragma rígido (penalización) — lógica compartida
  applyDiaphragmConstraintsW(S.writer(), model, nodeIndex, nDOF);

  if (withMass) {
    assembleAreasMassInto(M.writer(), model, nodeIndex);   // masa de áreas (ρ·t·A)
    applyDiaphragmMassW(M.writer(), model, nodeIndex);
    // Masas puntuales nodales (mx, my, mz)
    for (const node of model.nodes.values()) {
      const nm = node.nodeMass;
      if (!nm || (nm.mx === 0 && nm.my === 0 && nm.mz === 0)) continue;
      const b = nodeIndex.get(node.id) * 6;
      M.add(b,     b,     nm.mx || 0);
      M.add(b + 1, b + 1, nm.my || 0);
      M.add(b + 2, b + 2, nm.mz || 0);
    }
  }

  return { S, M, nDOF };
}

// ── Extracción libre–libre a CSR + acoplamiento fijo–libre para reacciones ────
// freeMap: Int32Array(nDOF) con el índice libre 0..nF-1, o −1 si el GDL está fijo.
// Devuelve:
//   csr  = { n:nF, rowPtr, colIdx, val }                 (K_ff comprimida)
//   cf   = { rowDof, ptr, freeIdx, val }                 (acoplamiento fijo→libre)
//          rowDof[r] = GDL global fijo; sus entradas (freeIdx, val) son K[fijo, libre].
export function extractFreeCSR(S, freeMap, nF) {
  const n = S.n;
  // Conteo de no-ceros por fila libre
  const cnt = new Int32Array(nF);
  for (let i = 0; i < n; i++) {
    const fi = freeMap[i];
    if (fi < 0) continue;
    const row = S.rows[i];
    let c = 0;
    for (const [j, v] of row) if (v !== 0 && freeMap[j] >= 0) c++;   // omitir ceros (cancelaciones exactas)
    cnt[fi] = c;
  }
  const rowPtr = new Int32Array(nF + 1);
  for (let r = 0; r < nF; r++) rowPtr[r + 1] = rowPtr[r] + cnt[r];
  const nnz = rowPtr[nF];
  const colIdx = new Int32Array(nnz);
  const val = new Float64Array(nnz);
  const cur = rowPtr.slice(0, nF);

  // Acoplamiento fijo–libre (reacciones)
  const cfRowDof = [], cfPtrArr = [0], cfFreeIdx = [], cfVal = [];

  for (let i = 0; i < n; i++) {
    const fi = freeMap[i];
    const row = S.rows[i];
    if (fi >= 0) {
      // fila libre → columnas libres, ordenadas por índice libre
      const entries = [];
      for (const [j, v] of row) { if (v === 0) continue; const fj = freeMap[j]; if (fj >= 0) entries.push([fj, v]); }
      entries.sort((a, b) => a[0] - b[0]);
      for (const [fj, v] of entries) { const p = cur[fi]++; colIdx[p] = fj; val[p] = v; }
    } else {
      // fila fija → acoplamiento a columnas libres (para reacciones). Se incluye
      // SIEMPRE el GDL fijo (aunque no tenga acoplamiento) para que la reacción
      // capture también las cargas aplicadas directamente en él (p.ej. térmicas):
      // reac = Σ K[fijo,libre]·u_libre − F[fijo]  →  si no hay acoplamiento, −F.
      for (const [j, v] of row) {
        if (v === 0) continue;
        const fj = freeMap[j];
        if (fj >= 0) { cfFreeIdx.push(fj); cfVal.push(v); }
      }
      cfRowDof.push(i); cfPtrArr.push(cfFreeIdx.length);
    }
  }

  return {
    csr: { n: nF, rowPtr, colIdx, val },
    cf: {
      rowDof: Int32Array.from(cfRowDof),
      ptr: Int32Array.from(cfPtrArr),
      freeIdx: Int32Array.from(cfFreeIdx),
      val: Float64Array.from(cfVal),
    },
  };
}
