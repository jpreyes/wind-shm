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

import { finalize } from './aisc360.js?v=175';

const ratObj = (D, C, extra = {}) => ({
  demanda: +(+D).toFixed(4), capacidad: +(+C).toFixed(4),
  ratio: C > 1e-12 ? +(D / C).toFixed(4) : Infinity, ...extra,
});

const ES_REBAR = 200e6;   // módulo del acero de refuerzo (kN/m²)

// Área de una barra de diámetro φ (mm) → m².
const barArea = dia => Math.PI * (dia / 1000) ** 2 / 4;

// Capas de armadura {As, dy} (dy = distancia desde la fibra comprimida) y Ast total.
// Soporta (a) capas explícitas reb.layers:[{n,dia,d}], (b) reb.{nTop,nBot,dia},
// (c) cuantía ρ (2 capas simétricas As/2). h = canto en la dirección de flexión.
function rebarLayers(reb, h, b, cover, rho) {
  if (Array.isArray(reb.layers) && reb.layers.length) {
    const layers = reb.layers.map(L => ({ As: L.As != null ? +L.As : (+L.n || 0) * barArea(+L.dia || 0), dy: +L.d }))
      .filter(L => L.As > 0 && Number.isFinite(L.dy));
    if (layers.length) return { layers, Ast: layers.reduce((s, L) => s + L.As, 0), nBars: reb.layers.reduce((s, L) => s + (+L.n || 0), 0) };
  }
  const dia = +reb.dia_mm || +reb.dia || 0;
  if (dia > 0 && ((+reb.nTop || 0) + (+reb.nBot || 0)) > 0) {
    const Ab = barArea(dia);
    const layers = [];
    if (+reb.nTop) layers.push({ As: reb.nTop * Ab, dy: cover });
    if (+reb.nBot) layers.push({ As: reb.nBot * Ab, dy: h - cover });
    return { layers, Ast: layers.reduce((s, L) => s + L.As, 0), nBars: (+reb.nTop || 0) + (+reb.nBot || 0) };
  }
  // Fallback ρ: 2 capas simétricas As/2.
  const Ast = rho * b * h;
  return { layers: [{ As: Ast / 2, dy: h - cover }, { As: Ast / 2, dy: cover }], Ast, nBars: null };
}

// ── Diagrama de interacción P–M REAL de una sección rectangular ──────────────────
// (#65/#70) Compatibilidad de deformaciones + bloque de Whitney (ACI 318-19):
// εcu=0.003, a=β1·c, acero elastoplástico (±fy). `layers` = capas de armadura
// {As, dy} (dy desde la fibra comprimida); `Ast` total. φ variable (0.65→0.90).
// Devuelve los puntos (M,P) de φ·diagrama (P compresión +).
//   b,h: ancho y canto en la dirección de flexión (m); fc,fy en kN/m².
function pmDiagram(b, h, fc, fy, layers, Ast, npts = 40) {
  const ecu = 0.003, ey = fy / ES_REBAR;
  const fcMPa = fc / 1000;
  let beta1 = 0.85 - 0.05 * (fcMPa - 28) / 7; beta1 = Math.min(0.85, Math.max(0.65, beta1));
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
  return { pts, Pmax, Po, beta1 };
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

// Capacidad de momento del diagrama a un axial dado Pu (M sobre la envolvente al
// nivel P=Pu; 0 si Pu supera el tope de compresión). Para el método del contorno
// de carga biaxial (#65).
function pmMomentAt(diag, Pu) {
  const pts = diag.pts; let M = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if ((a.P - Pu) * (b.P - Pu) <= 0 && a.P !== b.P) {
      const t = (Pu - a.P) / (b.P - a.P);
      M = Math.max(M, a.M + t * (b.M - a.M));
    }
  }
  return M;
}

function checkConcrete({ demands, mat, sec, member, options = {} }, codeLabel) {
  const fc = mat.fc, fy = mat.fyRebar;
  const reb = sec.rebar || (sec.design && sec.design.rebar) || {};
  const rho = reb.rho ?? options.cuantia_long_rho ?? 0.012;
  const cover = (reb.cover_mm ?? options.recubrimiento_mm ?? 40) / 1000;
  const phi = options.phi || {};
  const b = sec.b, h = sec.h, A = sec.A;
  const d = Math.max(h - cover, 0.5 * h);
  // Armadura longitudinal: capas explícitas (barras) o cuantía ρ (#70).
  const { layers: rebarL, Ast, nBars } = rebarLayers(reb, h, b, cover, rho);
  const stir = reb.stirrups || (reb.estribo_dia_mm ? { dia: reb.estribo_dia_mm, s: reb.estribo_s_mm } : null);

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

  // Corte: φVn = φ·(Vc + Vs). Vc = 0.17·√f'c·b·d (ACI 22.5, f'c en MPa). Con
  // estribos (#70): Vs = Av·fy·d/s ≤ 0.66·√f'c·b·d (tope ACI 22.5.1.2).
  const phiV = phi.corte ?? 0.75;
  const Vc0 = 0.17 * Math.sqrt(fc / 1000) * 1000 * b * d;
  let Vs0 = 0, corteFormula = 'φVc = φ·0.17·√f′c·b·d (sin estribos)';
  if (stir && +stir.dia > 0 && +stir.s > 0) {
    const Av = (+stir.legs || 2) * barArea(+stir.dia);
    Vs0 = Math.min(Av * fy * d / (+stir.s / 1000), 0.66 * Math.sqrt(fc / 1000) * 1000 * b * d);
    corteFormula = `φ(Vc+Vs), Vs=Av·fy·d/s (φ${(+stir.dia)}@${(+stir.s)}mm)`;
  }
  const corte = ratObj(Vmax, phiV * (Vc0 + Vs0), { formula: corteFormula });

  // Axial
  let axial, Pc;
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
  const biaxial = F.My > 1e-9 && F.Mz > 1e-9;
  let interaccion, diagrama = null;
  try {
    // Capas en la geometría de flexión (bb,hh); barras explícitas o ρ.
    const rl = rebarLayers(reb, hh, bb, cover, rho);
    const diag = pmDiagram(bb, hh, fc, fy, rl.layers, rl.Ast);
    if (biaxial) {
      // Método del CONTORNO DE CARGA (#65): (Mz/Mnz)^α + (My/Mny)^α ≤ 1, con Mnz,
      // Mny = capacidad uniaxial al axial Pu en cada eje; α (def. 1, conservador).
      const diagZ = pmDiagram(b, h, fc, fy, rebarLayers(reb, h, b, cover, rho).layers, rl.Ast);
      const diagY = pmDiagram(h, b, fc, fy, rebarLayers(reb, b, h, cover, rho).layers, rl.Ast);
      const Mnz = pmMomentAt(diagZ, Pu), Mny = pmMomentAt(diagY, Pu);
      const al = options.biaxialAlpha ?? 1.0;
      const r = (Mnz > 1e-12 ? Math.pow(F.Mz / Mnz, al) : Infinity) + (Mny > 1e-12 ? Math.pow(F.My / Mny, al) : Infinity);
      diagrama = { pts: diag.pts, Pu, Mz: F.Mz, My: F.My, Mnz, Mny, biaxial: true, nBars: rl.nBars };
      interaccion = ratObj(r, 1, { adim: true, modo: 'flexocompresión biaxial',
        armado: nBars ? `${nBars} barras` : `ρ=${rho}`,
        formula: `(Mz/Mnz)^${al}+(My/Mny)^${al} ≤ 1 (contorno de carga, Mnz/Mny al axial Pu)` });
    } else {
      const r = pmRatio(diag, Pu, Mu);
      diagrama = { pts: diag.pts, Pu, Mu, axis: bendStrong ? 'Mz' : 'My', nBars: rl.nBars };
      interaccion = ratObj(r, 1, { adim: true, modo: Pu >= 0 ? 'flexocompresión' : 'flexotracción',
        armado: nBars ? `${nBars} barras` : `ρ=${rho}`,
        formula: 'Diagrama P–M (compatibilidad de deformaciones + bloque de Whitney' + (nBars ? ', barras explícitas' : ', ρ') + ')' });
    }
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
