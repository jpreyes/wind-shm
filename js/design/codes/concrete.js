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

import { finalize } from './aisc360.js?v=144';

const ratObj = (D, C, extra = {}) => ({
  demanda: +(+D).toFixed(4), capacidad: +(+C).toFixed(4),
  ratio: C > 1e-12 ? +(D / C).toFixed(4) : Infinity, ...extra,
});

const ES_REBAR = 200e6;   // módulo del acero de refuerzo (kN/m²)

// ── Diagrama de interacción P–M REAL de una sección rectangular ──────────────────
// (#65) Compatibilidad de deformaciones + bloque de Whitney (ACI 318-19): εcu=0.003,
// a=β1·c, acero elastoplástico (±fy). Armado en 2 capas simétricas (As/2 a d y d′),
// más capas intermedias si se piden. φ variable (0.65 comp.-controlada → 0.90
// tracción-controlada). Devuelve los puntos (M,P) de φ·diagrama (P compresión +) y
// un evaluador radial del D/C para una demanda (Pu compresión +, Mu).
//   b,h: ancho y canto en la dirección de flexión (m); fc,fy en kN/m²; Ast total.
function pmDiagram(b, h, cover, fc, fy, Ast, npts = 40) {
  const ecu = 0.003, ey = fy / ES_REBAR;
  const fcMPa = fc / 1000;
  let beta1 = 0.85 - 0.05 * (fcMPa - 28) / 7; beta1 = Math.min(0.85, Math.max(0.65, beta1));
  const d = h - cover, dp = cover;                       // capas: tracción (d), compresión (d′)
  const layers = [{ As: Ast / 2, dy: d }, { As: Ast / 2, dy: dp }];   // dy = distancia desde fibra comprimida
  const Po = 0.85 * fc * (b * h - Ast) + fy * Ast;       // axial puro nominal
  const phiOf = et => et >= 0.005 ? 0.90 : et <= ey ? 0.65 : 0.65 + (et - ey) * 0.25 / (0.005 - ey);
  // c de muy grande (compresión pura) a pequeño (tracción): recorre el diagrama.
  const pts = [];
  const cList = [];
  for (let i = 0; i <= npts; i++) cList.push(3 * h * Math.pow(1 - i / npts, 1.4) + 1e-4);
  for (const c of cList) {
    const a = Math.min(beta1 * c, h);
    const Cc = 0.85 * fc * a * b;                         // compresión del hormigón
    let Pn = Cc, Mn = Cc * (h / 2 - a / 2);
    let etTens = 0;
    for (const L of layers) {
      const es = ecu * (c - L.dy) / c;                    // + compresión
      let fs = Math.max(-fy, Math.min(fy, ES_REBAR * es));
      if (es > 0 && L.dy <= a) fs -= 0.85 * fc;           // descuenta hormigón desplazado
      Pn += fs * L.As; Mn += fs * L.As * (h / 2 - L.dy);
      const etL = -es;                                     // tracción +
      if (etL > etTens) etTens = etL;
    }
    const phi = phiOf(etTens);
    pts.push({ P: phi * Pn, M: phi * Math.abs(Mn) });
  }
  // Punto de tracción pura (φ=0.90): P=−fy·Ast, M≈0.
  pts.push({ P: -0.90 * fy * Ast, M: 0 });
  const Pmax = 0.80 * 0.65 * Po;                           // tope ACI 22.4.2
  // Recorta la rama de compresión al tope Pn,max.
  for (const p of pts) if (p.P > Pmax) p.P = Pmax;
  return { pts, Pmax, Po, beta1, d };
}

// D/C radial: intersección del rayo origen→(Mu,Pu) con la poligonal del diagrama.
function pmRatio(diagram, Pu, Mu) {
  const pts = diagram.pts;
  if (Mu < 1e-9 && Math.abs(Pu) < 1e-9) return 0;
  // Recorre segmentos consecutivos buscando el cruce con el rayo t·(Mu,Pu), t>0.
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], bpt = pts[i + 1];
    // Resuelve  [dMx −Mu; dPx −Pu]·[s;t] = [−a.M; −a.P]  (Cramer).
    const dMx = bpt.M - a.M, dPx = bpt.P - a.P;
    const det = -dMx * Pu + dPx * Mu;
    if (Math.abs(det) < 1e-30) continue;
    const s = (a.M * Pu - Mu * a.P) / det;            // posición en el segmento [0,1]
    const t = (dPx * a.M - dMx * a.P) / det;          // posición en el rayo (t=1 → demanda)
    if (s >= -1e-6 && s <= 1 + 1e-6 && t > 1e-9) best = Math.min(best, 1 / t);
  }
  return Number.isFinite(best) ? best : Infinity;
}

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

  // Interacción P–M por DIAGRAMA real (#65): compatibilidad de deformaciones +
  // bloque de Whitney, φ variable. Eje de flexión = el del momento dominante.
  // P de compresión POSITIVO (en el modelo N<0 = compresión).
  const Pu = -F.N;                                          // compresión +
  const bendStrong = F.Mz >= F.My;                          // Mz → canto h, ancho b
  const bb = bendStrong ? b : h, hh = bendStrong ? h : b;
  const Mu = Math.max(F.My, F.Mz);
  let interaccion, diagrama = null;
  try {
    const diag = pmDiagram(bb, hh, cover, fc, fy, Ast);
    const r = pmRatio(diag, Pu, Mu);
    diagrama = { pts: diag.pts, Pu, Mu, axis: bendStrong ? 'Mz' : 'My' };
    interaccion = ratObj(r, 1, { adim: true, modo: Pu >= 0 ? 'flexocompresión' : 'flexotracción',
      formula: 'Diagrama P–M (compatibilidad de deformaciones + bloque de Whitney, φ variable)' });
  } catch (e) {
    const H = (Pc > 1e-12 ? Nabs / Pc : 0) + (Mn > 1e-12 ? Mmax / Mn : 0);
    interaccion = ratObj(H, 1, { adim: true, formula: 'Pu/φPn + Mu/φMn (lineal, respaldo)' });
  }

  return finalize({ material: 'hormigon', metodo: codeLabel, flexion, corte, axial, interaccion, diagrama }, options);
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
