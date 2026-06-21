// ──────────────────────────────────────────────────────────────────────────────
// membrane.js — Elementos 2D de TENSIÓN/DEFORMACIÓN PLANA (membrana).
//
//   · CST  — triángulo de deformación constante (3 nodos, 2 GDL/nodo).
//   · QUAD — cuadrilátero isoparamétrico de 4 nodos (integración 2×2 de Gauss).
//
// Ambos con material elástico + CARGA DE TEMPERATURA (deformación térmica inicial
// ε₀ = α·ΔT). Tensión plana o deformación plana. Fieles a CST.m/QUAD.m de
// Chandrupatla & Belegundu. Trabajan en coordenadas LOCALES 2D del elemento; el
// ensamblador las transforma a los GDL globales de traslación (cualquier plano 3D).
//
// Verificable en Node con un patch test.  El término de FLEXIÓN (placa) lo aporta
// plate.js → un área 'shell' = membrana + placa.
// Convención de GDL local: [u1,v1, u2,v2, ...] (x,y en el plano del elemento).
// ──────────────────────────────────────────────────────────────────────────────

import { mitc4Plate, dktPlate, plateMoments } from './plate.js?v=104';

// Matriz constitutiva D (3×3) plana. planeStrain=false → tensión plana.
export function Dmatrix(E, nu, planeStrain = false) {
  if (planeStrain) {
    const c = E / ((1 + nu) * (1 - 2 * nu));
    return [[c * (1 - nu), c * nu, 0], [c * nu, c * (1 - nu), 0], [0, 0, c * (1 - 2 * nu) / 2]];
  }
  const c = E / (1 - nu * nu);
  return [[c, c * nu, 0], [c * nu, c, 0], [0, 0, c * (1 - nu) / 2]];
}

// Deformación térmica inicial ε₀ = α·ΔT·[1,1,0]  (tensión plana).
// En deformación plana se amplifica por (1+ν) (el confinamiento fuera del plano).
function thermalStrain(alpha, dT, nu, planeStrain) {
  const e = alpha * dT * (planeStrain ? (1 + nu) : 1);
  return [e, e, 0];
}

// Bᵀ·D·B acumulado (helper): suma w·(Bᵀ D B) a Ke (n×n) y w·(Bᵀ D ε₀) a fThermal.
function accumulateBDB(Ke, fT, B, D, e0, w, nDOF) {
  // DB = D·B (3×nDOF)
  const DB = [new Float64Array(nDOF), new Float64Array(nDOF), new Float64Array(nDOF)];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < nDOF; c++)
      DB[r][c] = D[r][0] * B[0][c] + D[r][1] * B[1][c] + D[r][2] * B[2][c];
  // Ke += w·Bᵀ·DB ;  fT += w·Bᵀ·(D·ε₀)
  const De0 = [D[0][0] * e0[0] + D[0][1] * e0[1] + D[0][2] * e0[2],
               D[1][0] * e0[0] + D[1][1] * e0[1] + D[1][2] * e0[2],
               D[2][0] * e0[0] + D[2][1] * e0[1] + D[2][2] * e0[2]];
  for (let i = 0; i < nDOF; i++) {
    for (let j = 0; j < nDOF; j++)
      Ke[i * nDOF + j] += w * (B[0][i] * DB[0][j] + B[1][i] * DB[1][j] + B[2][i] * DB[2][j]);
    fT[i] += w * (B[0][i] * De0[0] + B[1][i] * De0[1] + B[2][i] * De0[2]);
  }
}

// ── CST: triángulo de deformación constante ─────────────────────────────────
// coords = [[x1,y1],[x2,y2],[x3,y3]] (2D local). Devuelve { Ke(6×6 plano), fT(6),
// B(3×6), area }. fT = vector de carga térmica (ε₀ = α·ΔT).
export function cstElement(coords, D, t, e0 = [0, 0, 0]) {
  const [[x1, y1], [x2, y2], [x3, y3]] = coords;
  const b1 = y2 - y3, b2 = y3 - y1, b3 = y1 - y2;
  const c1 = x3 - x2, c2 = x1 - x3, c3 = x2 - x1;
  const det = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
  const area = Math.abs(det) / 2;
  const inv2A = 1 / (det);   // 1/(2A) con signo (det = 2A orientado)
  // B (3×6): filas εx, εy, γxy ; cols [u1,v1,u2,v2,u3,v3]
  const B = [
    [b1 * inv2A, 0, b2 * inv2A, 0, b3 * inv2A, 0],
    [0, c1 * inv2A, 0, c2 * inv2A, 0, c3 * inv2A],
    [c1 * inv2A, b1 * inv2A, c2 * inv2A, b2 * inv2A, c3 * inv2A, b3 * inv2A],
  ];
  const Ke = new Float64Array(36), fT = new Float64Array(6);
  accumulateBDB(Ke, fT, B, D, e0, t * area, 6);
  return { Ke, fT, B, area };
}

// Tensión del CST: σ = D·(B·u − ε₀). u = [u1,v1,u2,v2,u3,v3] (local).
export function cstStress(B, D, u, e0 = [0, 0, 0]) {
  const eps = [0, 0, 0];
  for (let r = 0; r < 3; r++) { let s = 0; for (let c = 0; c < 6; c++) s += B[r][c] * u[c]; eps[r] = s - e0[r]; }
  return [
    D[0][0] * eps[0] + D[0][1] * eps[1] + D[0][2] * eps[2],
    D[1][0] * eps[0] + D[1][1] * eps[1] + D[1][2] * eps[2],
    D[2][0] * eps[0] + D[2][1] * eps[1] + D[2][2] * eps[2],
  ];
}

// ── QUAD: cuadrilátero isoparamétrico de 4 nodos (2×2 Gauss) ─────────────────
const G = 1 / Math.sqrt(3);
const GP = [[-G, -G], [G, -G], [G, G], [-G, G]];   // puntos de Gauss (w=1 c/u)

// Funciones de forma bilineales y sus derivadas en (ξ,η).
function shapeQ4(xi, eta) {
  const N = [(1 - xi) * (1 - eta) / 4, (1 + xi) * (1 - eta) / 4, (1 + xi) * (1 + eta) / 4, (1 - xi) * (1 + eta) / 4];
  const dNdxi = [-(1 - eta) / 4, (1 - eta) / 4, (1 + eta) / 4, -(1 + eta) / 4];
  const dNdeta = [-(1 - xi) / 4, -(1 + xi) / 4, (1 + xi) / 4, (1 - xi) / 4];
  return { N, dNdxi, dNdeta };
}

// B (3×8) y det(J) en un punto de Gauss. coords = [[x,y]×4].
function bMatrixQ4(coords, xi, eta) {
  const { dNdxi, dNdeta } = shapeQ4(xi, eta);
  let J00 = 0, J01 = 0, J10 = 0, J11 = 0;
  for (let i = 0; i < 4; i++) {
    J00 += dNdxi[i] * coords[i][0]; J01 += dNdxi[i] * coords[i][1];
    J10 += dNdeta[i] * coords[i][0]; J11 += dNdeta[i] * coords[i][1];
  }
  const detJ = J00 * J11 - J01 * J10;
  const iJ00 = J11 / detJ, iJ01 = -J01 / detJ, iJ10 = -J10 / detJ, iJ11 = J00 / detJ;
  const B = [new Float64Array(8), new Float64Array(8), new Float64Array(8)];
  for (let i = 0; i < 4; i++) {
    const dNdx = iJ00 * dNdxi[i] + iJ01 * dNdeta[i];
    const dNdy = iJ10 * dNdxi[i] + iJ11 * dNdeta[i];
    B[0][2 * i] = dNdx;            // εx
    B[1][2 * i + 1] = dNdy;        // εy
    B[2][2 * i] = dNdy; B[2][2 * i + 1] = dNdx;   // γxy
  }
  return { B, detJ };
}

// Devuelve { Ke(8×8 plano), fT(8), area }. e0 = ε₀ térmica.
export function quadElement(coords, D, t, e0 = [0, 0, 0]) {
  const Ke = new Float64Array(64), fT = new Float64Array(8);
  let area = 0;
  for (const [xi, eta] of GP) {
    const { B, detJ } = bMatrixQ4(coords, xi, eta);
    area += detJ;
    accumulateBDB(Ke, fT, B, D, e0, t * detJ, 8);
  }
  return { Ke, fT, area };
}

// Tensión del QUAD en el CENTRO (ξ=η=0). u = [u1,v1,...,u4,v4] (local).
export function quadStressCenter(coords, D, u, e0 = [0, 0, 0]) {
  const { B } = bMatrixQ4(coords, 0, 0);
  const eps = [0, 0, 0];
  for (let r = 0; r < 3; r++) { let s = 0; for (let c = 0; c < 8; c++) s += B[r][c] * u[c]; eps[r] = s - e0[r]; }
  return [
    D[0][0] * eps[0] + D[0][1] * eps[1] + D[0][2] * eps[2],
    D[1][0] * eps[0] + D[1][1] * eps[1] + D[1][2] * eps[2],
    D[2][0] * eps[0] + D[2][1] * eps[1] + D[2][2] * eps[2],
  ];
}

// Tensiones de von Mises (plana): √(σx²−σxσy+σy²+3τxy²).
export function vonMises([sx, sy, txy]) { return Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * txy * txy); }

export { thermalStrain };

// ── Integración 3D: membrana en cualquier plano del espacio ─────────────────
const _sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const _dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const _nrm = a => Math.sqrt(_dot(a, a));

// Marco local 2D del elemento a partir de sus coords 3D: ex (nodo1→nodo2),
// ez (normal = ex×(nodo1→nodo3)), ey = ez×ex. Devuelve {ex,ey,ez, local:[[x,y]…]}.
export function areaLocalFrame(coords3d) {
  const p0 = coords3d[0];
  const e1 = _sub(coords3d[1], p0);
  const ex = e1.map(v => v / (_nrm(e1) || 1));
  let z = _cross(e1, _sub(coords3d[2], p0));
  const ez = z.map(v => v / (_nrm(z) || 1));
  const ey = _cross(ez, ex);
  const local = coords3d.map(p => { const d = _sub(p, p0); return [_dot(d, ex), _dot(d, ey)]; });
  return { ex, ey, ez, local };
}

// Construye {D, el(local Ke/fT), ex,ey,ez, gdof, nN} de un área (geometría + material).
function _areaSetup(area, model, nodeIndex, e0) {
  const coords3d = area.nodes.map(id => { const n = model.nodes.get(id); return n ? [n.x, n.y, n.z] : null; });
  const mat = model.materials.get(area.matId);
  if (coords3d.some(c => !c) || !mat) return null;
  const { ex, ey, ez, local } = areaLocalFrame(coords3d);
  const D = Dmatrix(mat.E, mat.nu, area.planeStrain);
  const nN = area.nodes.length;
  const el = nN === 3 ? cstElement(local, D, area.thickness, e0) : quadElement(local, D, area.thickness, e0);
  const gdof = area.nodes.map(id => 6 * nodeIndex.get(id));   // base GDL global (traslaciones gdof+0..2)
  return { D, el, ex, ey, ez, gdof, nN, local, mat };
}

// ¿El área incluye comportamiento de membrana / placa según su 'behavior'?
const hasMembrane = a => (a.behavior ?? 'membrane') !== 'plate';
const hasPlate = a => { const b = a.behavior ?? 'membrane'; return b === 'plate' || b === 'shell'; };

// Ensambla la rigidez de TODAS las áreas en el writer {add(i,j,v)} (denso o disperso).
//   · Membrana: transforma los 2 GDL locales en-plano (ex,ey) → 3 GDL globales de
//     traslación.
//   · Placa:    transforma los 3 GDL locales [w,θx,θy] → traslación normal (w·ez) y
//     rotaciones globales (θx·ex + θy·ey).
// Regulariza SOLO las direcciones de GDL no cubiertas (evita singularidad sin
// rigidizar la respuesta real): traslación normal si no hay placa; rotaciones
// flectoras si no hay placa; SIEMPRE el giro de "drilling" (alrededor de ez).
export function assembleAreasInto(writer, model, nodeIndex, opts = {}) {
  const regN = opts.regN ?? 1e-4, regR = opts.regR ?? 1e-4;
  for (const area of model.areas.values()) {
    const S = _areaSetup(area, model, nodeIndex, [0, 0, 0]);
    if (!S) continue;
    const { el, ex, ey, ez, gdof, nN, local, mat } = S;
    const mem = hasMembrane(area), pla = hasPlate(area);
    let kref = 0;

    if (mem) {                       // ── membrana (en-plano) ──────────────────
      const Ke = el.Ke, m = 2 * nN, R = [ex, ey];
      for (let a = 0; a < nN; a++) for (let b = 0; b < nN; b++)
        for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) {
          let v = 0;
          for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) v += R[p][r] * Ke[(2 * a + p) * m + (2 * b + q)] * R[q][s];
          if (v !== 0) writer.add(gdof[a] + r, gdof[b] + s, v);
        }
      for (let i = 0; i < m; i++) kref = Math.max(kref, Ke[i * m + i]);
    }

    if (pla) {                       // ── placa (flexión) ─────────────────────
      const Kp = nN === 3 ? dktPlate(local, mat.E, mat.nu, area.thickness)
                          : mitc4Plate(local, mat.E, mat.nu, area.thickness);
      // Transform. nodal 6×3: cols [w,θx,θy] → filas [tx,ty,tz,rx,ry,rz].
      const Tn = [[ez[0], 0, 0], [ez[1], 0, 0], [ez[2], 0, 0],
                  [0, ex[0], ey[0]], [0, ex[1], ey[1]], [0, ex[2], ey[2]]];
      const m = 3 * nN;
      for (let a = 0; a < nN; a++) for (let b = 0; b < nN; b++)
        for (let r = 0; r < 6; r++) for (let s = 0; s < 6; s++) {
          let v = 0;
          for (let p = 0; p < 3; p++) { const tap = Tn[r][p]; if (!tap) continue;
            for (let q = 0; q < 3; q++) v += tap * Kp[(3 * a + p) * m + (3 * b + q)] * Tn[s][q]; }
          if (v !== 0) writer.add(gdof[a] + r, gdof[b] + s, v);
        }
      for (let i = 0; i < m; i++) kref = Math.max(kref, Kp[i * m + i]);
    }

    // ── Regularización de GDL no cubiertos ──────────────────────────────────
    const kn = regN * kref, kr = regR * kref;
    for (let a = 0; a < nN; a++) {
      if (!mem)                       // traslaciones en-plano (ex,ey) sin cubrir
        for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) { const v = kn * (ex[r] * ex[s] + ey[r] * ey[s]); if (v !== 0) writer.add(gdof[a] + r, gdof[a] + s, v); }
      if (!pla)                       // traslación normal (ez) sin cubrir
        for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) { const v = kn * ez[r] * ez[s]; if (v !== 0) writer.add(gdof[a] + r, gdof[a] + s, v); }
      if (pla) {                      // placa cubre flexión: regular SOLO drilling (ez)
        for (let r = 3; r < 6; r++) for (let s = 3; s < 6; s++) { const v = kr * ez[r - 3] * ez[s - 3]; if (v !== 0) writer.add(gdof[a] + r, gdof[a] + s, v); }
      } else {                        // sin placa: regular las 3 rotaciones
        for (let r = 3; r < 6; r++) writer.add(gdof[a] + r, gdof[a] + r, kr);
      }
    }
  }
}

// Masa de las áreas para el análisis modal: masa total m = ρ·t·A repartida por
// igual entre los nodos (lumped), aplicada a los 3 GDL de traslación de cada nodo.
export function assembleAreasMassInto(writer, model, nodeIndex) {
  for (const area of model.areas.values()) {
    const S = _areaSetup(area, model, nodeIndex, [0, 0, 0]);
    if (!S) continue;
    const { el, gdof, nN, mat } = S;
    const m = (mat.rho || 0) * (area.thickness || 0) * (el.area || 0);
    if (!(m > 0)) continue;
    const mn = m / nN;
    for (let a = 0; a < nN; a++)
      for (let r = 0; r < 3; r++) writer.add(gdof[a] + r, gdof[a] + r, mn);
  }
}

// Aportes de carga térmica de un área a F (lista de {dof, val}).
export function areaThermalContribs(area, model, nodeIndex, dT) {
  const mat = model.materials.get(area.matId); if (!mat) return [];
  const e0 = thermalStrain(mat.alpha ?? 0, dT || 0, mat.nu, area.planeStrain);
  const S = _areaSetup(area, model, nodeIndex, e0); if (!S) return [];
  const { el, ex, ey, gdof, nN } = S;
  const fT = el.fT, R = [ex, ey], out = [];
  for (let a = 0; a < nN; a++)
    for (let r = 0; r < 3; r++) out.push({ dof: gdof[a] + r, val: R[0][r] * fT[2 * a] + R[1][r] * fT[2 * a + 1] });
  return out;
}

// Tensión del área (en el centro) a partir del campo global u y de ΔT.
export function areaStress(area, model, nodeIndex, u, dT = 0) {
  const mat = model.materials.get(area.matId); if (!mat) return null;
  const e0 = thermalStrain(mat.alpha ?? 0, dT || 0, mat.nu, area.planeStrain);
  const S = _areaSetup(area, model, nodeIndex, e0); if (!S) return null;
  const { D, ex, ey, gdof, nN, local } = S;
  // u local en-plano por nodo: ul = R·U_global
  const ul = [];
  for (let a = 0; a < nN; a++) {
    const U = [u[gdof[a]] || 0, u[gdof[a] + 1] || 0, u[gdof[a] + 2] || 0];
    ul.push(_dot(ex, U), _dot(ey, U));
  }
  return nN === 3 ? cstStress(cstElement(local, D, area.thickness).B, D, ul, e0)
                  : quadStressCenter(local, D, ul, e0);
}

// Tensión de FLEXIÓN en la fibra de superficie (placa/shell): σ = 6·M/t²
// [σx,σy,τxy] en el marco local, a partir de los momentos de placa en el centro.
// Devuelve null si el área no tiene flexión (membrana pura).
export function areaBendingStress(area, model, nodeIndex, u) {
  if (!hasPlate(area)) return null;
  const S = _areaSetup(area, model, nodeIndex, [0, 0, 0]); if (!S) return null;
  const { ex, ey, ez, gdof, nN, local, mat } = S;
  const dLocal = [];
  for (let a = 0; a < nN; a++) {
    const Ut = [u[gdof[a]] || 0, u[gdof[a] + 1] || 0, u[gdof[a] + 2] || 0];
    const Ur = [u[gdof[a] + 3] || 0, u[gdof[a] + 4] || 0, u[gdof[a] + 5] || 0];
    dLocal.push(_dot(ez, Ut), _dot(ex, Ur), _dot(ey, Ur));   // [w, θx, θy]
  }
  const t = area.thickness;
  const M = plateMoments(local, mat.E, mat.nu, t, dLocal);
  const c = 6 / (t * t);
  return [c * M[0], c * M[1], c * M[2]];   // tensión de superficie (fibra inferior)
}
