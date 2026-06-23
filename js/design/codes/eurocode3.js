// ──────────────────────────────────────────────────────────────────────────────
// eurocode3.js — Diseño de ACERO según Eurocódigo 3 (EN 1993-1-1).
//
//   · 6.2.3 tracción           Npl,Rd = A·fy/γM0
//   · 6.3.1 compresión         Nb,Rd = χ·A·fy/γM1   (curvas de pandeo a,b,c,d)
//   · 5.5   clasificación      clase 1/2 → plástico (Wpl); clase 3 → elástico (Wel)
//   · 6.3.2 flexión + LTB      Mb,Rd = χLT·Wy·fy/γM1 (Mcr de I bisimétrico)
//   · 6.2.6 corte              Vpl,Rd = Av·fy/(√3·γM0)
//   · 6.3.3 interacción        lineal conservadora (NEd/Nb + My/Mb + Mz/Mc,z ≤ 1)
//
// Unidades: kN, m, kN/m². γM0, γM1 y las curvas de pandeo son configurables en
// options. Equivalente a la verificación de acero Eurocode 3 de SAP2000 para los
// modos cubiertos. Para mayor fidelidad de interacción úsense kyy/kzz (Anexo B).
// ──────────────────────────────────────────────────────────────────────────────

import { finalize } from './aisc360.js?v=137';

const ALPHA = { a0: 0.13, a: 0.21, b: 0.34, c: 0.49, d: 0.76 };   // factores de imperfección
const ratObj = (D, C, extra = {}) => ({
  demanda: +(+D).toFixed(4), capacidad: +(+C).toFixed(4),
  ratio: C > 1e-12 ? +(D / C).toFixed(4) : Infinity, ...extra,
});

// χ de pandeo (6.3.1.2): Φ=0.5(1+α(λ̄−0.2)+λ̄²); χ=1/(Φ+√(Φ²−λ̄²)) ≤ 1.
function chi(lambdaBar, alpha, lambda0 = 0.2) {
  const Phi = 0.5 * (1 + alpha * (lambdaBar - lambda0) + lambdaBar * lambdaBar);
  return Math.min(1, 1 / (Phi + Math.sqrt(Math.max(Phi * Phi - lambdaBar * lambdaBar, 0))));
}

function checkEC3({ demands, mat, sec, member, options = {} }) {
  const fy = mat.Fy, E = mat.E, G = mat.G || E / 2.6;
  const gM0 = options.gammaM0 ?? 1.0, gM1 = options.gammaM1 ?? 1.0;
  const curve = ALPHA[options.bucklingCurve || 'b'], curveLT = ALPHA[options.ltCurve || 'b'];
  const L = member.L || 1, Lb = member.Lb || L, Kz = member.Kz ?? member.K ?? 1, Ky = member.Ky ?? member.K ?? 1;
  const C1 = member.C1 ?? member.Cb ?? 1.0;
  const { A, Sz, Sy, Zz, Zy, rz, ry, Iy, Cw, J, Avy, Avz, shape, lambdaFlange, lambdaWeb } = sec;

  const F = {
    N: demands.N || 0, Nsign: Math.sign(demands.N || 0) || 1,
    Vy: Math.abs(demands.Vy || 0), Vz: Math.abs(demands.Vz || 0),
    My: Math.abs(demands.My || 0), Mz: Math.abs(demands.Mz || 0),
  };
  const Nabs = Math.abs(F.N);

  // ── Clasificación de sección (5.5, Tabla 5.2) ───────────────────────────────
  const eps = Math.sqrt(235 / (fy / 1000));   // fy en MPa
  let clase = 1;
  if (shape === 'I') {
    const cfl = lambdaFlange, cw = lambdaWeb;
    const flCls = cfl <= 9 * eps ? 1 : cfl <= 10 * eps ? 2 : cfl <= 14 * eps ? 3 : 4;
    const wbCls = cw <= 72 * eps ? 1 : cw <= 83 * eps ? 2 : cw <= 124 * eps ? 3 : 4;
    clase = Math.max(flCls, wbCls);
  }
  const plastico = clase <= 2;
  const Wz = plastico ? Zz : Sz, Wy = plastico ? Zy : Sy;   // módulo eje fuerte/débil

  // ── 6.2.3 tracción / 6.3.1 compresión ───────────────────────────────────────
  let axial, Nrd, axMode;
  if (F.Nsign >= 0) {
    Nrd = A * fy / gM0; axMode = 'tracción';
    axial = ratObj(Nabs, Nrd, { modo: 'tracción', formula: 'Npl,Rd = A·fy/γM0 (6.2.3)' });
  } else {
    const Ncrz = Math.PI ** 2 * E * sec.Iz / (Kz * L) ** 2;
    const Ncry = Math.PI ** 2 * E * Iy / (Ky * L) ** 2;
    const lamZ = Math.sqrt(A * fy / Ncrz), lamY = Math.sqrt(A * fy / Ncry);
    const lamBar = Math.max(lamZ, lamY);                 // gobierna la mayor esbeltez
    const chiC = chi(lamBar, curve);
    Nrd = chiC * A * fy / gM1; axMode = 'compresión';
    axial = ratObj(Nabs, Nrd, { modo: 'compresión', lambdaBar: +lamBar.toFixed(3), chi: +chiC.toFixed(3),
      formula: 'Nb,Rd = χ·A·fy/γM1 (6.3.1)' });
  }

  // ── 6.3.2 flexión con pandeo lateral-torsional (eje fuerte) ─────────────────
  const Mcz = Wz * fy / gM0;                              // resistencia de sección eje fuerte
  let Mbz = Mcz, ltb = 'sin LTB';
  if (shape === 'I' && Iy > 0 && Cw > 0) {
    // Mcr de viga I bisimétrica (cargas en el c.g.): Mcr = C1·π²EI_minor/L²·√(Cw/I_minor + L²GJ/(π²EI_minor))
    const Imin = Iy;
    const Mcr = C1 * Math.PI ** 2 * E * Imin / Lb ** 2 *
      Math.sqrt(Cw / Imin + Lb ** 2 * G * J / (Math.PI ** 2 * E * Imin));
    const lamLT = Math.sqrt(Wz * fy / Mcr);
    const chiLT = Math.min(chi(lamLT, curveLT, 0.2), 1);
    Mbz = chiLT * Wz * fy / gM1;
    ltb = `λ̄LT=${lamLT.toFixed(3)}, χLT=${chiLT.toFixed(3)}`;
  }
  const Mcy = Wy * fy / gM0;
  const rbz = Mbz > 1e-12 ? F.Mz / Mbz : 0, rby = Mcy > 1e-12 ? F.My / Mcy : 0;
  const flexion = rbz >= rby
    ? ratObj(F.Mz, Mbz, { eje: 'fuerte (Mz)', clase, ltb, formula: 'Mb,Rd = χLT·Wy·fy/γM1 (6.3.2)' })
    : ratObj(F.My, Mcy, { eje: 'débil (My)', clase, formula: 'Mc,Rd = W·fy/γM0 (6.2.5)' });

  // ── 6.2.6 corte ──────────────────────────────────────────────────────────────
  const Vrdz = Avy * fy / (Math.sqrt(3) * gM0), Vrdy = Avz * fy / (Math.sqrt(3) * gM0);
  const rvz = Vrdz > 1e-12 ? F.Vy / Vrdz : 0, rvy = Vrdy > 1e-12 ? F.Vz / Vrdy : 0;
  const corte = rvz >= rvy
    ? ratObj(F.Vy, Vrdz, { dir: 'Vy (alma)', formula: 'Vpl,Rd = Av·fy/(√3·γM0) (6.2.6)' })
    : ratObj(F.Vz, Vrdy, { dir: 'Vz (alas)', formula: 'Vpl,Rd = Av·fy/(√3·γM0) (6.2.6)' });

  // ── 6.3.3 interacción (lineal conservadora) ─────────────────────────────────
  const H = (Nrd > 1e-12 ? Nabs / Nrd : 0) + (Mbz > 1e-12 ? F.Mz / Mbz : 0) + (Mcy > 1e-12 ? F.My / Mcy : 0);
  const interaccion = ratObj(H, 1, { adim: true, modo: axMode,
    formula: 'NEd/Nb,Rd + My/Mb,Rd + Mz/Mc,z,Rd ≤ 1 (6.3.3, lineal conserv.)' });

  return finalize({ material: 'acero', metodo: 'Eurocódigo 3 (EN 1993-1-1)', flexion, corte, axial, interaccion }, options);
}

export const eurocode3 = {
  id: 'EN1993-1-1', family: 'steel', label: 'Eurocódigo 3 (EN 1993-1-1)',
  check: checkEC3,
};
