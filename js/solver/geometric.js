// ──────────────────────────────────────────────────────────────────────────────
// geometric.js — Rigidez GEOMÉTRICA de frames (NL-lite Fase 2).
//
// La matriz de rigidez geométrica Kg(N) captura el efecto de la fuerza axial N
// sobre la rigidez transversal (efecto P-Δ y pandeo). Sumada a la elástica:
//   · P-Delta:   (K + Kg)·u = F   → desplazamientos amplificados.
//   · Pandeo:    (K + λ·Kg)·φ = 0 → factor crítico λcr y modo de pandeo φ.
//
// Convención de signos IDÉNTICA a timoshenko.js (DOF local
// [u1,v1,w1,rx1,ry1,rz1, u2,v2,w2,rx2,ry2,rz2], plano XZ con dw/dx = −θy).
// N en TRACCIÓN positiva (compresión N<0 → reduce la rigidez → pandeo).
// ──────────────────────────────────────────────────────────────────────────────
import { localAxes, transformMatrix, globalStiffness } from './timoshenko.js?v=122';

// 12×12 geométrica local a partir del axial N (tracción +) y la longitud L.
// Forma consistente (Przemieniecti) para flexión en ambos planos; los términos
// axial y de torsión geométricos se desprecian (estándar para pandeo por flexión).
export function geometricMatrixLocal(N, L) {
  const Kg = Array.from({ length: 12 }, () => Array(12).fill(0));
  const c = N / L;
  const a = 6 / 5, b = L / 10, d = 2 * L * L / 15, e = -L * L / 30;

  // Plano XY (flexión sobre z): DOF [v1=1, θz1=5, v2=7, θz2=11]
  const xy = [1, 5, 7, 11];
  const Gxy = [
    [ a,  b, -a,  b],
    [ b,  d, -b,  e],
    [-a, -b,  a, -b],
    [ b,  e, -b,  d],
  ];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) Kg[xy[i]][xy[j]] = c * Gxy[i][j];

  // Plano XZ (flexión sobre y): DOF [w1=2, θy1=4, w2=8, θy2=10]
  // dw/dx = −θy ⇒ se invierten los acoplamientos traslación–giro (como en KXZ).
  const xz = [2, 4, 8, 10];
  const Gxz = [
    [ a, -b, -a, -b],
    [-b,  d,  b,  e],
    [-a,  b,  a,  b],
    [-b,  e,  b,  d],
  ];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) Kg[xz[i]][xz[j]] = c * Gxz[i][j];

  return Kg;
}

// DOFs globales (0-based) de un nodo
function dofs(nodeIndex, id) {
  const b = 6 * nodeIndex.get(id);
  return [b, b + 1, b + 2, b + 3, b + 4, b + 5];
}

// Ensambla la rigidez geométrica global (densa, nDOF×nDOF) a partir del campo de
// desplazamientos uGlobal: para cada elemento calcula su axial N desde la
// elongación local (N = EA·Δ/L, tracción +) y arma Kg = Tᵀ·Kg_local·T.
// Devuelve { Kg, Nmax, Nby } (Nmax = |N| máximo, para diagnóstico; Nby = Map
// elemId → N axial bajo uGlobal, tracción +, usado p.ej. para la carga de pandeo
// por elemento = λcr·N).
export function assembleKg(model, nodeIndex, uGlobal) {
  const nDOF = nodeIndex.size * 6;
  const Kg = new Float64Array(nDOF * nDOF);
  const Nby = new Map();
  let Nmax = 0;

  for (const elem of model.elements.values()) {
    const n1 = model.nodes.get(elem.n1), n2 = model.nodes.get(elem.n2);
    const mat = model.materials.get(elem.matId), sec = model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) continue;

    const { ex, ey, ez, L } = localAxes(n1, n2);
    const T  = transformMatrix(ex, ey, ez);
    const ed = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];

    // Axial N desde la elongación local: u_local = T·u_global; Δ = u_local[6]−u_local[0]
    const ug = ed.map(g => uGlobal[g] || 0);
    let ul0 = 0, ul6 = 0;
    for (let j = 0; j < 12; j++) { ul0 += T[0][j] * ug[j]; ul6 += T[6][j] * ug[j]; }
    const mA = sec.mod?.A ?? 1;
    const EA = mat.E * sec.A * mA;
    const N = EA * (ul6 - ul0) / L;       // tracción positiva
    Nby.set(elem.id, N);
    if (Math.abs(N) > Nmax) Nmax = Math.abs(N);

    const KgG = globalStiffness(geometricMatrixLocal(N, L), T);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++)
        Kg[ed[i] * nDOF + ed[j]] += KgG[i][j];
  }
  return { Kg, Nmax, Nby };
}
