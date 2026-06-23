// ──────────────────────────────────────────────────────────────────────────────
// concrete.js — Diseño de HORMIGÓN ARMADO (ACI 318-19 / EN 1992-1-1).
//
// Las secciones del modelo son genéricas (A, I); el armado se describe con una
// cuantía longitudinal ρ y un recubrimiento (sec.design.rebar) o valores por
// defecto. Resistencias f'c y fy del refuerzo se toman del MATERIAL resuelto
// (kN/m²). φ por ACI (flexión 0.90, corte 0.75, compresión 0.65).
//
// Unidades: kN, m, kN/m². √f'c usa f'c en MPa (kN/m² ÷ 1000).
// ──────────────────────────────────────────────────────────────────────────────

import { finalize } from './aisc360.js?v=137';

const ratObj = (D, C, extra = {}) => ({
  demanda: +(+D).toFixed(4), capacidad: +(+C).toFixed(4),
  ratio: C > 1e-12 ? +(D / C).toFixed(4) : Infinity, ...extra,
});

function checkConcrete({ demands, mat, sec, member, options = {} }, codeLabel) {
  const fc = mat.fc, fy = mat.fyRebar;
  const reb = (sec.design && sec.design.rebar) || {};
  const rho = reb.rho ?? options.cuantia_long_rho ?? 0.012;
  const cover = (reb.cover_mm ?? options.recubrimiento_mm ?? 40) / 1000;
  const phi = options.phi || {};
  const b = sec.b, h = sec.h, A = sec.A;
  const d = Math.max(h - cover, 0.5 * h);

  const F = {
    N: demands.N || 0, Nsign: Math.sign(demands.N || 0) || 1,
    Vy: Math.abs(demands.Vy || 0), Vz: Math.abs(demands.Vz || 0),
    My: Math.abs(demands.My || 0), Mz: Math.abs(demands.Mz || 0),
  };
  const Nabs = Math.abs(F.N), Mmax = Math.max(F.My, F.Mz), Vmax = Math.max(F.Vy, F.Vz);

  // Flexión: As=ρ·b·d ; a=As·fy/(0.85 f'c b) ; φMn=φ·As·fy·(d−a/2)
  const As = rho * b * d;
  const a = As * fy / (0.85 * fc * b);
  const Mn = (phi.flexion ?? 0.90) * As * fy * (d - a / 2);
  const flexion = ratObj(Mmax, Mn, { rho, b: +b.toFixed(3), d: +d.toFixed(3),
    formula: 'φMn = φ·As·fy·(d−a/2), As=ρ·b·d' });

  // Corte: φVc = φ·0.17·√f'c·b·d (ACI 22.5, f'c en MPa)
  const Vc = (phi.corte ?? 0.75) * 0.17 * Math.sqrt(fc / 1000) * 1000 * b * d;
  const corte = ratObj(Vmax, Vc, { formula: 'φVc = φ·0.17·√f′c·b·d (sin estribos)' });

  // Axial
  let axial, Pc;
  const Ast = rho * A;
  if (F.Nsign < 0) {
    Pc = (phi.axial_compresion ?? 0.65) * 0.80 * (0.85 * fc * (A - Ast) + fy * Ast);
    axial = ratObj(Nabs, Pc, { modo: 'compresión', formula: 'φPn = φ·0.80·(0.85·f′c·(Ag−Ast)+fy·Ast)' });
  } else {
    Pc = (phi.flexion ?? 0.90) * fy * Ast;
    axial = ratObj(Nabs, Pc, { modo: 'tracción', formula: 'φPn = φ·fy·As (tracción → armadura)' });
  }

  // Interacción P-M lineal simplificada (conservadora)
  const H = (Pc > 1e-12 ? Nabs / Pc : 0) + (Mn > 1e-12 ? Mmax / Mn : 0);
  const interaccion = ratObj(H, 1, { adim: true, formula: 'Pu/φPn + Mu/φMn (lineal simplificada)' });

  return finalize({ material: 'hormigon', metodo: codeLabel, flexion, corte, axial, interaccion }, options);
}

export const aci318 = {
  id: 'ACI318-19', family: 'concrete', label: 'ACI 318-19',
  check: (input) => checkConcrete(input, 'Resistencia última (ACI 318-19)'),
};
// EC2 comparte el mismo procedimiento simplificado aquí (mismas fórmulas de bloque
// rectangular); se distingue por etiqueta. Para EC2 riguroso úsense γc, γs y el
// diagrama parábola-rectángulo.
export const eurocode2 = {
  id: 'EN1992-1-1', family: 'concrete', label: 'Eurocódigo 2 (EN 1992-1-1, simplificado)',
  check: (input) => checkConcrete(input, 'Resistencia última (EN 1992-1-1, simplificado)'),
};
