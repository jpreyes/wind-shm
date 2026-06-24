// ──────────────────────────────────────────────────────────────────────────────
// eurocode3.js — Diseño de ACERO según Eurocódigo 3 (EN 1993-1-1).
//
//   · 6.2.3 tracción           Npl,Rd = A·fy/γM0
//   · 6.3.1 compresión         Nb,Rd = χ·A·fy/γM1   (curvas de pandeo a,b,c,d)
//   · 5.5   clasificación      clase 1/2 → plástico (Wpl); clase 3 → elástico (Wel)
//   · 6.3.2 flexión + LTB      Mb,Rd = χLT·Wy·fy/γM1 (Mcr de I bisimétrico)
//   · 6.2.6 corte              Vpl,Rd = Av·fy/(√3·γM0)
//   · 6.3.3 interacción        eqs. 6.61/6.62 con kij del ANEXO B (Método 2) en
//                              compresión; lineal en tracción+flexión (6.2.1)
//
// Unidades: kN, m, kN/m². γM0, γM1, las curvas de pandeo y los Cmy/Cmz/CmLT son
// configurables en options/member. Equivalente a la verificación de acero
// Eurocode 3 de SAP2000 (Método 2) para los modos cubiertos. Nota de ejes: este
// código usa z = eje fuerte (mayor EC3) e y = eje débil (menor EC3).
// ──────────────────────────────────────────────────────────────────────────────

import { finalize } from './aisc360.js?v=181';

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
  // NOTA de ejes: este código usa z = eje FUERTE (mayor), y = eje DÉBIL (menor),
  // al revés que EC3 (y = mayor). Más abajo se mapea para la interacción 6.3.3.
  const NRk = A * fy;
  let axial, Nrd, axMode;
  // Reducciones de pandeo por eje (válidas para compresión; se reusan en 6.3.3).
  const Ncr_major = Math.PI ** 2 * E * sec.Iz / (Kz * L) ** 2;   // pandeo eje fuerte (Iz)
  const Ncr_minor = Math.PI ** 2 * E * Iy / (Ky * L) ** 2;        // pandeo eje débil (Iy)
  const lamMajor = Math.sqrt(NRk / Ncr_major), lamMinor = Math.sqrt(NRk / Ncr_minor);
  const chiMajor = chi(lamMajor, curve), chiMinor = chi(lamMinor, curve);
  if (F.Nsign >= 0) {
    Nrd = NRk / gM0; axMode = 'tracción';
    axial = ratObj(Nabs, Nrd, { modo: 'tracción', formula: 'Npl,Rd = A·fy/γM0 (6.2.3)' });
  } else {
    const chiC = Math.min(chiMajor, chiMinor);
    const lamBar = chiMajor <= chiMinor ? lamMajor : lamMinor;
    Nrd = chiC * NRk / gM1; axMode = 'compresión';
    axial = ratObj(Nabs, Nrd, { modo: 'compresión', lambdaBar: +lamBar.toFixed(3), chi: +chiC.toFixed(3),
      formula: 'Nb,Rd = χ·A·fy/γM1 (6.3.1)' });
  }

  // ── 6.3.2 flexión con pandeo lateral-torsional (eje fuerte) ─────────────────
  const Mcz = Wz * fy / gM0;                              // resistencia de sección eje fuerte
  let Mbz = Mcz, ltb = 'sin LTB', chiLT = 1;
  if (shape === 'I' && Iy > 0 && Cw > 0) {
    // Mcr de viga I bisimétrica (cargas en el c.g.): Mcr = C1·π²EI_minor/L²·√(Cw/I_minor + L²GJ/(π²EI_minor))
    const Imin = Iy;
    const Mcr = C1 * Math.PI ** 2 * E * Imin / Lb ** 2 *
      Math.sqrt(Cw / Imin + Lb ** 2 * G * J / (Math.PI ** 2 * E * Imin));
    const lamLT = Math.sqrt(Wz * fy / Mcr);
    chiLT = Math.min(chi(lamLT, curveLT, 0.2), 1);
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

  // ── 6.3.3 interacción flexo-compresión (eqs. 6.61/6.62) ─────────────────────
  // Factores kij del ANEXO B (Método 2), clase 1/2, miembros susceptibles a torsión.
  // Mapeo de ejes: EC3 "y"(mayor)↔código z(fuerte); EC3 "z"(menor)↔código y(débil).
  let interaccion;
  if (F.Nsign < 0 && (Nrd > 0)) {
    const Cmy = options.Cmy ?? member.Cmy ?? 0.9;        // mayor (= Mz del modelo)
    const Cmz = options.Cmz ?? member.Cmz ?? 0.9;        // menor (= My del modelo)
    const CmLT = options.CmLT ?? member.CmLT ?? Cmy;
    const NbRk_M = chiMajor * NRk / gM1, NbRk_m = chiMinor * NRk / gM1;
    const ny = NbRk_M > 0 ? Nabs / NbRk_M : 0;           // n eje mayor
    const nz = NbRk_m > 0 ? Nabs / NbRk_m : 0;           // n eje menor
    // kyy, kzz (Tabla B.1) y kyz, kzy (Tabla B.2, susceptible a torsión).
    const kyy = Math.min(Cmy * (1 + (lamMajor - 0.2) * ny), Cmy * (1 + 0.8 * ny));
    const kzz = Math.min(Cmz * (1 + (2 * lamMinor - 0.6) * nz), Cmz * (1 + 1.4 * nz));
    const kyz = 0.6 * kzz;
    const denomLT = Math.max(CmLT - 0.25, 1e-6);
    const kzy = Math.max(1 - 0.1 * lamMinor * nz / denomLT, 1 - 0.1 * nz / denomLT);
    // Resistencias características (γM1) de las eqs. 6.61/6.62.
    const MyRd = chiLT * Wz * fy / gM1;                  // mayor con LTB
    const MzRd = Wy * fy / gM1;                          // menor
    const t1 = Nabs / (chiMajor * NRk / gM1) + kyy * (MyRd > 0 ? F.Mz / MyRd : 0) + kyz * (MzRd > 0 ? F.My / MzRd : 0);
    const t2 = Nabs / (chiMinor * NRk / gM1) + kzy * (MyRd > 0 ? F.Mz / MyRd : 0) + kzz * (MzRd > 0 ? F.My / MzRd : 0);
    const H = Math.max(t1, t2);
    interaccion = ratObj(H, 1, { adim: true, modo: 'flexocompresión',
      kyy: +kyy.toFixed(3), kyz: +kyz.toFixed(3), kzy: +kzy.toFixed(3), kzz: +kzz.toFixed(3),
      formula: 'eqs. 6.61/6.62 con kij del Anexo B (Método 2)' });
  } else {
    // Tracción + flexión: combinación lineal (6.2.1).
    const H = (Nrd > 1e-12 ? Nabs / Nrd : 0) + (Mbz > 1e-12 ? F.Mz / Mbz : 0) + (Mcy > 1e-12 ? F.My / Mcy : 0);
    interaccion = ratObj(H, 1, { adim: true, modo: axMode,
      formula: 'NEd/Nt,Rd + My/Mb,Rd + Mz/Mc,z,Rd ≤ 1 (tracción, lineal)' });
  }

  return finalize({ material: 'acero', metodo: 'Eurocódigo 3 (EN 1993-1-1)', flexion, corte, axial, interaccion }, options);
}

export const eurocode3 = {
  id: 'EN1993-1-1', family: 'steel', label: 'Eurocódigo 3 (EN 1993-1-1)',
  check: checkEC3,
};
