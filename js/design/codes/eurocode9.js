// ──────────────────────────────────────────────────────────────────────────────
// eurocode9.js — Diseño de ALUMINIO según Eurocódigo 9 (EN 1999-1-1).
//
// El aluminio NO es acero: módulo E ≈ 70 GPa (≈ ⅓ del acero), resistencia de
// referencia = límite elástico convencional al 0.2 % `fo` (no fy), coeficientes
// parciales propios (γM1=1.10 pandeo de miembro, γM2=1.25 sección neta) y curvas
// de pandeo distintas. Esta implementación cubre:
//
//   · 6.2.3 tracción        No,Rd = A·fo/γM1   (sección bruta; neta con fu/γM2)
//   · 6.3.1 compresión      Nb,Rd = κ·χ·A·fo/γM1  (κ = factor HAZ/local, def. 1)
//   · 6.2.5/6.3.2 flexión   Mc,Rd = α·Wel·fo/γM1 (α = factor de forma por clase) + LTB
//   · 6.2.6 corte           Vo,Rd = Av·fo/(√3·γM1)
//   · 6.3.3 interacción     lineal conservadora (refinamiento con exponentes ξ/η/γ
//                           de EN 1999-1-1 pendiente)
//
// Curvas de pandeo EC9 (Tabla 6.6): clase A (aleaciones tratadas térmicamente)
// α=0.20, λ̄0=0.10; clase B (no tratadas/soldadas) α=0.32, λ̄0=0.0. Por defecto A.
//
// `fo` se toma del material resuelto (mat.Fy en kN/m², que para aluminio ES el
// límite convencional 0.2 %); `E` del material (debe ser ≈70 GPa para aluminio).
// Unidades: kN, m, kN/m².
// ──────────────────────────────────────────────────────────────────────────────

import { finalize } from './aisc360.js?v=153';

const CURVES = { A: { alpha: 0.20, l0: 0.10 }, B: { alpha: 0.32, l0: 0.0 } };
const ratObj = (D, C, extra = {}) => ({
  demanda: +(+D).toFixed(4), capacidad: +(+C).toFixed(4),
  ratio: C > 1e-12 ? +(D / C).toFixed(4) : Infinity, ...extra,
});

function chi(lambdaBar, { alpha, l0 }) {
  const Phi = 0.5 * (1 + alpha * (lambdaBar - l0) + lambdaBar * lambdaBar);
  return Math.min(1, 1 / (Phi + Math.sqrt(Math.max(Phi * Phi - lambdaBar * lambdaBar, 0))));
}

function checkEC9({ demands, mat, sec, member, options = {} }) {
  const fo = mat.Fy, fu = mat.Fu, E = mat.E, G = mat.G || E / 2.6;
  const gM1 = options.gammaM1 ?? 1.10, gM2 = options.gammaM2 ?? 1.25;
  const curve = CURVES[options.bucklingCurve || 'A'] || CURVES.A;
  const curveLT = CURVES[options.ltCurve || 'A'] || CURVES.A;
  const kHaz = options.haz ?? member.haz ?? 1.0;          // reducción zona afectada por calor (≤1)
  const L = member.L || 1, Lb = member.Lb || L, K = member.K ?? 1;
  const C1 = member.C1 ?? member.Cb ?? 1.0;
  const { A, Sz, Sy, Zz, Zy, Iy, Cw, J, Avy, Avz, shape, lambdaFlange, lambdaWeb } = sec;

  const F = {
    N: demands.N || 0, Nsign: Math.sign(demands.N || 0) || 1,
    Vy: Math.abs(demands.Vy || 0), Vz: Math.abs(demands.Vz || 0),
    My: Math.abs(demands.My || 0), Mz: Math.abs(demands.Mz || 0),
  };
  const Nabs = Math.abs(F.N);

  // Clasificación (EN 1999-1-1 6.1.4, ε=√(250/fo[MPa])). Aproximada con límites EC3.
  const eps = Math.sqrt(250 / (fo / 1000));
  let clase = 1;
  if (shape === 'I') {
    const flCls = lambdaFlange <= 9 * eps ? 1 : lambdaFlange <= 10 * eps ? 2 : lambdaFlange <= 14 * eps ? 3 : 4;
    const wbCls = lambdaWeb <= 72 * eps ? 1 : lambdaWeb <= 83 * eps ? 2 : lambdaWeb <= 124 * eps ? 3 : 4;
    clase = Math.max(flCls, wbCls);
  }
  const plastico = clase <= 2;
  const Wz = plastico ? Zz : Sz, Wy = plastico ? Zy : Sy;

  // ── tracción / compresión ────────────────────────────────────────────────────
  let axial, Nrd, axMode;
  if (F.Nsign >= 0) {
    const Ngross = A * fo / gM1, Nnet = 0.9 * A * fu / gM2;   // sin huecos: Anet=A
    Nrd = Math.min(Ngross, Nnet); axMode = 'tracción';
    axial = ratObj(Nabs, Nrd, { modo: 'tracción', formula: 'No,Rd = mín(A·fo/γM1, 0.9·Anet·fu/γM2)' });
  } else {
    const Ncrz = Math.PI ** 2 * E * sec.Iz / (K * L) ** 2;
    const Ncry = Math.PI ** 2 * E * Iy / (K * L) ** 2;
    const lamBar = Math.sqrt(A * fo / Math.min(Ncrz, Ncry));
    const chiC = chi(lamBar, curve);
    Nrd = kHaz * chiC * A * fo / gM1; axMode = 'compresión';
    axial = ratObj(Nabs, Nrd, { modo: 'compresión', lambdaBar: +lamBar.toFixed(3), chi: +chiC.toFixed(3),
      kHaz, formula: 'Nb,Rd = κ·χ·A·fo/γM1 (6.3.1, curva EC9)' });
  }

  // ── flexión + LTB (eje fuerte) ───────────────────────────────────────────────
  let Mbz = Wz * fo / gM1, ltb = 'sin LTB';
  if (shape === 'I' && Iy > 0 && Cw > 0) {
    const Mcr = C1 * Math.PI ** 2 * E * Iy / Lb ** 2 * Math.sqrt(Cw / Iy + Lb ** 2 * G * J / (Math.PI ** 2 * E * Iy));
    const lamLT = Math.sqrt(Wz * fo / Mcr);
    const chiLT = chi(lamLT, curveLT);
    Mbz = chiLT * Wz * fo / gM1;
    ltb = `λ̄LT=${lamLT.toFixed(3)}, χLT=${chiLT.toFixed(3)}`;
  }
  const Mcy = Wy * fo / gM1;
  const rbz = Mbz > 1e-12 ? F.Mz / Mbz : 0, rby = Mcy > 1e-12 ? F.My / Mcy : 0;
  const flexion = rbz >= rby
    ? ratObj(F.Mz, Mbz, { eje: 'fuerte (Mz)', clase, ltb, formula: 'Mb,Rd = χLT·α·Wel·fo/γM1 (6.3.2)' })
    : ratObj(F.My, Mcy, { eje: 'débil (My)', clase, formula: 'Mc,Rd = α·Wel·fo/γM1 (6.2.5)' });

  // ── corte ────────────────────────────────────────────────────────────────────
  const Vrdz = Avy * fo / (Math.sqrt(3) * gM1), Vrdy = Avz * fo / (Math.sqrt(3) * gM1);
  const rvz = Vrdz > 1e-12 ? F.Vy / Vrdz : 0, rvy = Vrdy > 1e-12 ? F.Vz / Vrdy : 0;
  const corte = rvz >= rvy
    ? ratObj(F.Vy, Vrdz, { dir: 'Vy (alma)', formula: 'Vo,Rd = Av·fo/(√3·γM1) (6.2.6)' })
    : ratObj(F.Vz, Vrdy, { dir: 'Vz (alas)', formula: 'Vo,Rd = Av·fo/(√3·γM1) (6.2.6)' });

  // ── interacción (lineal conservadora) ────────────────────────────────────────
  const H = (Nrd > 1e-12 ? Nabs / Nrd : 0) + (Mbz > 1e-12 ? F.Mz / Mbz : 0) + (Mcy > 1e-12 ? F.My / Mcy : 0);
  const interaccion = ratObj(H, 1, { adim: true, modo: axMode,
    formula: 'NEd/Nb,Rd + My/Mb,Rd + Mz/Mc,z,Rd ≤ 1 (6.3.3, lineal conserv.)' });

  return finalize({ material: 'aluminio', metodo: 'Eurocódigo 9 (EN 1999-1-1)', flexion, corte, axial, interaccion }, options);
}

export const eurocode9 = {
  id: 'EN1999-1-1', family: 'aluminum', label: 'Eurocódigo 9 (EN 1999-1-1)',
  check: checkEC9,
};
