// ──────────────────────────────────────────────────────────────────────────────
// plate.js — Elementos de PLACA A FLEXIÓN (bending).  Shell = membrana + placa.
//
//   · MITC4 — cuadrilátero Mindlin-Reissner de 4 nodos con interpolación de corte
//             ASUMIDA (Bathe-Dvorkin 1985) → SIN bloqueo por corte (thin & thick).
//   · DKT   — Discrete Kirchhoff Triangle de 3 nodos (Batoz 1980), placa delgada.
//
// Convención de GDL local por nodo:  [w, θx, θy]
//   w  = traslación transversal (según la normal ez del plano del elemento)
//   θx = rotación alrededor del eje local x (ex)
//   θy = rotación alrededor del eje local y (ey)
//   → consistente con los GDL rotacionales de los frames, de modo que un nodo
//     compartido entre placa y barra acopla correctamente.
//
//   Campo de desplazamientos:  u = z·θy ,  v = −z·θx ,  w = w   (ω×r, ω=(θx,θy,0))
//   Curvaturas:  κ = [∂θy/∂x ; −∂θx/∂y ; ∂θy/∂y − ∂θx/∂x]
//   Corte:       γ = [∂w/∂x + θy ; ∂w/∂y − θx]
//
// AUTÓNOMO (sin dependencias) → verificable en Node (placa cuadrada apoyada/empotrada).
// ──────────────────────────────────────────────────────────────────────────────

// Constitutiva de flexión de placa Db (3×3) = (t³/12)·Dp, con Dp tensión plana.
// Devuelve también Ds (corte, 2×2) = κs·G·t·I.
export function plateD(E, nu, t) {
  const cp = E / (1 - nu * nu);
  const f = t * t * t / 12;
  const Db = [[cp * f, cp * nu * f, 0], [cp * nu * f, cp * f, 0], [0, 0, cp * (1 - nu) / 2 * f]];
  const G = E / (2 * (1 + nu));
  const ks = 5 / 6;
  const Ds = [[ks * G * t, 0], [0, ks * G * t]];
  return { Db, Ds };
}

// ── MITC4 ────────────────────────────────────────────────────────────────────
const G1 = 1 / Math.sqrt(3);
const GP4 = [[-G1, -G1], [G1, -G1], [G1, G1], [-G1, G1]];

// Funciones de forma bilineales y derivadas naturales en (ξ,η).
function shapeQ4(xi, eta) {
  const N = [(1 - xi) * (1 - eta) / 4, (1 + xi) * (1 - eta) / 4, (1 + xi) * (1 + eta) / 4, (1 - xi) * (1 + eta) / 4];
  const dNdxi = [-(1 - eta) / 4, (1 - eta) / 4, (1 + eta) / 4, -(1 + eta) / 4];
  const dNdeta = [-(1 - xi) / 4, -(1 + xi) / 4, (1 + xi) / 4, (1 - xi) / 4];
  return { N, dNdxi, dNdeta };
}

// Jacobiano J = [[∂x/∂ξ,∂y/∂ξ],[∂x/∂η,∂y/∂η]] y su inversa.
function jacQ4(coords, dNdxi, dNdeta) {
  let J00 = 0, J01 = 0, J10 = 0, J11 = 0;
  for (let i = 0; i < 4; i++) {
    J00 += dNdxi[i] * coords[i][0]; J01 += dNdxi[i] * coords[i][1];
    J10 += dNdeta[i] * coords[i][0]; J11 += dNdeta[i] * coords[i][1];
  }
  const detJ = J00 * J11 - J01 * J10;
  const iJ = [[J11 / detJ, -J01 / detJ], [-J10 / detJ, J00 / detJ]];
  return { J: [[J00, J01], [J10, J11]], iJ, detJ };
}

// Componente de corte COVARIANTE en un punto:  γ_ξ ó γ_η  (12-vector sobre GDL).
//   γ_ξ = ∂w/∂ξ + θy·∂x/∂ξ − θx·∂y/∂ξ ;  γ_η análogo con ∂/∂η.
// Devuelve filas {gXi, gEta} (Float64Array(12)) en función de los GDL [w,θx,θy]×4.
function covariantShearRows(coords, xi, eta) {
  const { dNdxi, dNdeta, N } = shapeQ4(xi, eta);
  const { J } = jacQ4(coords, dNdxi, dNdeta);
  const dxdxi = J[0][0], dydxi = J[0][1], dxdeta = J[1][0], dydeta = J[1][1];
  const gXi = new Float64Array(12), gEta = new Float64Array(12);
  for (let i = 0; i < 4; i++) {
    const c = 3 * i;
    // γ_ξ : ∂w/∂ξ + θy·∂x/∂ξ − θx·∂y/∂ξ
    gXi[c] = dNdxi[i];                       // w
    gXi[c + 1] = -N[i] * dydxi;              // θx
    gXi[c + 2] = N[i] * dxdxi;               // θy
    // γ_η
    gEta[c] = dNdeta[i];
    gEta[c + 1] = -N[i] * dydeta;
    gEta[c + 2] = N[i] * dxdeta;
  }
  return { gXi, gEta };
}

// Bb (3×12) de flexión en un punto de Gauss.  κ = [∂θy/∂x ; −∂θx/∂y ; ∂θy/∂y−∂θx/∂x].
function bBendingQ4(coords, xi, eta) {
  const { dNdxi, dNdeta } = shapeQ4(xi, eta);
  const { iJ, detJ } = jacQ4(coords, dNdxi, dNdeta);
  const Bb = [new Float64Array(12), new Float64Array(12), new Float64Array(12)];
  for (let i = 0; i < 4; i++) {
    const dNdx = iJ[0][0] * dNdxi[i] + iJ[0][1] * dNdeta[i];
    const dNdy = iJ[1][0] * dNdxi[i] + iJ[1][1] * dNdeta[i];
    const c = 3 * i;
    Bb[0][c + 2] = dNdx;            // ∂θy/∂x
    Bb[1][c + 1] = -dNdy;           // −∂θx/∂y
    Bb[2][c + 2] = dNdy;            // ∂θy/∂y
    Bb[2][c + 1] = -dNdx;           // −∂θx/∂x
  }
  return { Bb, detJ };
}

// Bs (2×12) de corte ASUMIDO MITC4 en un punto (ξ,η).
// γ_ξ ligado en A(0,−1),C(0,1) (lineal en η); γ_η en B(1,0),D(−1,0) (lineal en ξ).
// Cartesiano [γxz;γyz] = J⁻¹·[γ_ξ;γ_η].
function bShearMITC4(coords, xi, eta) {
  const A = covariantShearRows(coords, 0, -1).gXi;   // γ_ξ en A
  const C = covariantShearRows(coords, 0, 1).gXi;    // γ_ξ en C
  const B = covariantShearRows(coords, 1, 0).gEta;   // γ_η en B
  const D = covariantShearRows(coords, -1, 0).gEta;  // γ_η en D
  const gXi = new Float64Array(12), gEta = new Float64Array(12);
  for (let k = 0; k < 12; k++) {
    gXi[k] = 0.5 * (1 - eta) * A[k] + 0.5 * (1 + eta) * C[k];
    gEta[k] = 0.5 * (1 + xi) * B[k] + 0.5 * (1 - xi) * D[k];
  }
  const { dNdxi, dNdeta } = shapeQ4(xi, eta);
  const { iJ } = jacQ4(coords, dNdxi, dNdeta);
  const Bs = [new Float64Array(12), new Float64Array(12)];
  for (let k = 0; k < 12; k++) {
    Bs[0][k] = iJ[0][0] * gXi[k] + iJ[0][1] * gEta[k];   // γxz
    Bs[1][k] = iJ[1][0] * gXi[k] + iJ[1][1] * gEta[k];   // γyz
  }
  return Bs;
}

// Ke(12×12) MITC4.  DOF por nodo [w,θx,θy].
export function mitc4Plate(coords, E, nu, t) {
  const { Db, Ds } = plateD(E, nu, t);
  const Ke = new Float64Array(144);
  for (const [xi, eta] of GP4) {
    const { Bb, detJ } = bBendingQ4(coords, xi, eta);
    const Bs = bShearMITC4(coords, xi, eta);
    // Kb += detJ·Bbᵀ Db Bb
    const DB = [new Float64Array(12), new Float64Array(12), new Float64Array(12)];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 12; c++) DB[r][c] = Db[r][0] * Bb[0][c] + Db[r][1] * Bb[1][c] + Db[r][2] * Bb[2][c];
    // Ks += detJ·Bsᵀ Ds Bs
    const DS = [new Float64Array(12), new Float64Array(12)];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 12; c++) DS[r][c] = Ds[r][0] * Bs[0][c] + Ds[r][1] * Bs[1][c];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
      let v = 0;
      for (let r = 0; r < 3; r++) v += Bb[r][i] * DB[r][j];
      for (let r = 0; r < 2; r++) v += Bs[r][i] * DS[r][j];
      Ke[i * 12 + j] += detJ * v;
    }
  }
  return Ke;
}

// ── DKT (Batoz) ──────────────────────────────────────────────────────────────
// Constructor de la matriz B (3×9) del DKT y el área, compartido por la rigidez
// (dktPlate) y la recuperación de momentos (plateMoments).  Construcción
// serendípita autoritativa (a,b,c,d,e) de Batoz–Bathe–Ho (1980).
function _dktBMat(coords) {
  const [[x1, y1], [x2, y2], [x3, y3]] = coords;
  const x23 = x2 - x3, x31 = x3 - x1, x12 = x1 - x2;
  const y23 = y2 - y3, y31 = y3 - y1, y12 = y1 - y2;
  const A2 = x31 * y12 - x12 * y31;                // = 2·Area (orientado)
  const Ar = Math.abs(A2) / 2;
  const L = { 4: x23 * x23 + y23 * y23, 5: x31 * x31 + y31 * y31, 6: x12 * x12 + y12 * y12 };
  const xij = { 4: x23, 5: x31, 6: x12 }, yij = { 4: y23, 5: y31, 6: y12 };
  const a = {}, b = {}, c = {}, d = {}, e = {};
  for (const k of [4, 5, 6]) {
    a[k] = -xij[k] / L[k];
    b[k] = 0.75 * xij[k] * yij[k] / L[k];
    c[k] = (0.25 * xij[k] * xij[k] - 0.5 * yij[k] * yij[k]) / L[k];
    d[k] = -yij[k] / L[k];
    e[k] = (0.25 * yij[k] * yij[k] - 0.5 * xij[k] * xij[k]) / L[k];
  }

  // Derivadas de las N serendípitas en (ξ,η).  L1=1-ξ-η, L2=ξ, L3=η.
  function dN(xi, eta) {
    const l1 = 1 - xi - eta;
    return {
      dxi: [(4 * l1 - 1) * -1, 4 * xi - 1, 0, 4 * eta, -4 * eta, 4 * (1 - 2 * xi - eta)],
      det: [(4 * l1 - 1) * -1, 0, 4 * eta - 1, 4 * xi, 4 * (1 - xi - 2 * eta), -4 * xi],
    };
  }
  // Hx, Hy (9-vectores) y sus derivadas ∂/∂ξ, ∂/∂η (combinaciones lineales de dN).
  function HxHy(xi, eta) {
    const { dxi, det } = dN(xi, eta);
    const N1x = dxi[0], N2x = dxi[1], N3x = dxi[2], N4x = dxi[3], N5x = dxi[4], N6x = dxi[5];
    const N1e = det[0], N2e = det[1], N3e = det[2], N4e = det[3], N5e = det[4], N6e = det[5];
    const Hxxi = [
      1.5 * (a[6] * N6x - a[5] * N5x), b[5] * N5x + b[6] * N6x, N1x - c[5] * N5x - c[6] * N6x,
      1.5 * (a[4] * N4x - a[6] * N6x), b[4] * N4x + b[6] * N6x, N2x - c[4] * N4x - c[6] * N6x,
      1.5 * (a[5] * N5x - a[4] * N4x), b[4] * N4x + b[5] * N5x, N3x - c[4] * N4x - c[5] * N5x];
    const Hxeta = [
      1.5 * (a[6] * N6e - a[5] * N5e), b[5] * N5e + b[6] * N6e, N1e - c[5] * N5e - c[6] * N6e,
      1.5 * (a[4] * N4e - a[6] * N6e), b[4] * N4e + b[6] * N6e, N2e - c[4] * N4e - c[6] * N6e,
      1.5 * (a[5] * N5e - a[4] * N4e), b[4] * N4e + b[5] * N5e, N3e - c[4] * N4e - c[5] * N5e];
    const Hyxi = [
      1.5 * (d[6] * N6x - d[5] * N5x), -N1x + e[5] * N5x + e[6] * N6x, -b[5] * N5x - b[6] * N6x,
      1.5 * (d[4] * N4x - d[6] * N6x), -N2x + e[4] * N4x + e[6] * N6x, -b[4] * N4x - b[6] * N6x,
      1.5 * (d[5] * N5x - d[4] * N4x), -N3x + e[4] * N4x + e[5] * N5x, -b[4] * N4x - b[5] * N5x];
    const Hyeta = [
      1.5 * (d[6] * N6e - d[5] * N5e), -N1e + e[5] * N5e + e[6] * N6e, -b[5] * N5e - b[6] * N6e,
      1.5 * (d[4] * N4e - d[6] * N6e), -N2e + e[4] * N4e + e[6] * N6e, -b[4] * N4e - b[6] * N6e,
      1.5 * (d[5] * N5e - d[4] * N4e), -N3e + e[4] * N4e + e[5] * N5e, -b[4] * N4e - b[5] * N5e];
    return { Hxxi, Hyxi, Hxeta, Hyeta };
  }

  // B (3×9) en (ξ,η).  κ = [∂βx/∂x ; ∂βy/∂y ; ∂βx/∂y+∂βy/∂x], cadena con J⁻¹.
  function bMat(xi, eta) {
    const { Hxxi, Hyxi, Hxeta, Hyeta } = HxHy(xi, eta);
    const B = [new Float64Array(9), new Float64Array(9), new Float64Array(9)];
    for (let k = 0; k < 9; k++) {
      B[0][k] = (y31 * Hxxi[k] + y12 * Hxeta[k]) / A2;
      B[1][k] = (-x31 * Hyxi[k] - x12 * Hyeta[k]) / A2;
      B[2][k] = (-x31 * Hxxi[k] - x12 * Hxeta[k] + y31 * Hyxi[k] + y12 * Hyeta[k]) / A2;
    }
    return B;
  }
  return { bMat, Ar };
}

// Triángulo Kirchhoff delgado.  DOF por nodo [w,θx,θy] (θx=rot x, θy=rot y).
// Integración de 3 puntos en los puntos medios de los lados.
export function dktPlate(coords, E, nu, t) {
  const { bMat, Ar } = _dktBMat(coords);
  const cp = E / (1 - nu * nu), f = t * t * t / 12;
  const Db = [[cp * f, cp * nu * f, 0], [cp * nu * f, cp * f, 0], [0, 0, cp * (1 - nu) / 2 * f]];

  const Ke = new Float64Array(81);
  const gp = [[0.5, 0], [0.5, 0.5], [0, 0.5]];   // puntos medios de lados, peso A/3
  for (const [xi, eta] of gp) {
    const B = bMat(xi, eta);
    const DB = [new Float64Array(9), new Float64Array(9), new Float64Array(9)];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) DB[r][c] = Db[r][0] * B[0][c] + Db[r][1] * B[1][c] + Db[r][2] * B[2][c];
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) {
      let v = 0; for (let r = 0; r < 3; r++) v += B[r][i] * DB[r][j];
      Ke[i * 9 + j] += (Ar / 3) * v;
    }
  }
  // Convención de Batoz (θx=−∂w/∂y, θy=∂w/∂x) → la NUESTRA (θx=∂w/∂y, θy=−∂w/∂x)
  // negando filas/columnas rotacionales (índices 1,2,4,5,7,8).  Hace que comparta
  // los GDL rotacionales con MITC4 y los frames.
  const sgn = [1, -1, -1, 1, -1, -1, 1, -1, -1];
  for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) Ke[i * 9 + j] *= sgn[i] * sgn[j];
  return Ke;
}

// ── Recuperación de momentos de placa ────────────────────────────────────────
// Momentos por unidad de longitud [Mx, My, Mxy] en el centro del elemento, a
// partir de los GDL locales dLocal = [w,θx,θy]×nN (NUESTRA convención).  Sirven
// para la tensión de fibra superficie σ = ±6·M/t².
// Curvaturas de placa [κx, κy, κxy] en el centro (centroide en DKT). Sólo
// dependen de la geometría y los GDL locales [w,θx,θy] por nodo, no del material.
export function plateCurvatures(coords, dLocal) {
  const nN = coords.length;
  let B, nD, d = dLocal;
  if (nN === 4) {
    B = bBendingQ4(coords, 0, 0).Bb;   // centro (ξ=η=0)
    nD = 12;
  } else {
    d = dLocal.slice();
    for (let aN = 0; aN < 3; aN++) { d[3 * aN + 1] *= -1; d[3 * aN + 2] *= -1; }
    B = _dktBMat(coords).bMat(1 / 3, 1 / 3);   // centroide
    nD = 9;
  }
  const kappa = [0, 0, 0];
  for (let r = 0; r < 3; r++) { let s = 0; for (let k = 0; k < nD; k++) s += B[r][k] * d[k]; kappa[r] = s; }
  return kappa;
}

export function plateMoments(coords, E, nu, t, dLocal) {
  const { Db } = plateD(E, nu, t);
  const kappa = plateCurvatures(coords, dLocal);
  return [
    Db[0][0] * kappa[0] + Db[0][1] * kappa[1] + Db[0][2] * kappa[2],
    Db[1][0] * kappa[0] + Db[1][1] * kappa[1] + Db[1][2] * kappa[2],
    Db[2][0] * kappa[0] + Db[2][1] * kappa[1] + Db[2][2] * kappa[2],
  ];
}
