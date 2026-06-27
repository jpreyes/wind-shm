// ──────────────────────────────────────────────────────────────────────────────
// section_props.js — Propiedades de sección para DISEÑO de elementos.
//
// Dada la forma (shape) y dimensiones de una sección, calcula TODO lo que los
// códigos de diseño (AISC 360, Eurocódigo 3, ACI 318…) necesitan y que la sección
// genérica del solver (A, Iy, Iz, J) no aporta: módulos elásticos S, módulos
// PLÁSTICOS Z, radios de giro r, constante de alabeo Cw, áreas de corte Av y
// relaciones de esbeltez de pared (b/t, h/tw) para clasificar la sección.
//
// Convención de ejes (igual que el solver): z = eje FUERTE (mayor), y = eje DÉBIL
// (menor). Unidades del modelo: metros. Todas las longitudes en m, A en m², I en m⁴.
//
// Formas soportadas (shape):
//   'I'      — doble T / perfil I bisimétrico:  { d, bf, tf, tw }
//   'rect'   — rectángulo macizo:               { b, h }   (h = canto, eje fuerte)
//   'circle' — círculo macizo:                  { D }
//   'pipe'   — tubo circular (hueco):           { D, t }
//   'box'    — tubo rectangular (hueco):        { b, h, t }
//   'generic'— sólo A, Iy, Iz conocidos → rectángulo equivalente (comportamiento
//              histórico de Pórtico). Z = shapeFactor·S.
//
// Cualquier propiedad puede sobreescribirse explícitamente en sec.design (p.ej.
// dar Zz/Cw tabulados de un perfil real). Para A, Iy, Iz, J se prefiere SIEMPRE el
// valor de la sección del modelo (lo que ve el solver) cuando existe, para que el
// análisis y el diseño sean consistentes.
// ──────────────────────────────────────────────────────────────────────────────

import { polygonProps } from './polygon_props.js?v=208';

// Torsión de St. Venant de un rectángulo macizo (lado largo a, corto b).
function rectJ(a, b) {
  if (b <= 0) return 0;
  const [L, W] = a >= b ? [a, b] : [b, a];
  return L * W ** 3 * (1 / 3 - 0.21 * (W / L) * (1 - (W / L) ** 4 / 12));
}

// ── Propiedades de un COMPUESTO DE RECTÁNGULOS (para C, L, T, …) ─────────────────
// rects: [{x0,x1,y0,y1}] (m). Calcula A, centroide (cx,cy), inercias centroidales
// Iz=∫(y−cy)²dA (eje fuerte horizontal) e Iy=∫(x−cx)²dA, módulos elásticos a la
// fibra más alejada y módulos PLÁSTICOS Zz/Zy (eje neutro plástico = línea que parte
// el área en mitades, hallado por bisección + integral analítica del momento |·|).
function rectsProps(rects) {
  let A = 0, Sx = 0, Sy = 0;
  for (const r of rects) { const a = (r.x1 - r.x0) * (r.y1 - r.y0); A += a; Sx += a * (r.x0 + r.x1) / 2; Sy += a * (r.y0 + r.y1) / 2; }
  const cx = Sx / A, cy = Sy / A;
  let Iz = 0, Iy = 0, xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const r of rects) {
    const w = r.x1 - r.x0, h = r.y1 - r.y0, a = w * h;
    const rx = (r.x0 + r.x1) / 2 - cx, ry = (r.y0 + r.y1) / 2 - cy;
    Iz += w * h ** 3 / 12 + a * ry * ry;        // bending about z (horizontal): integra y²
    Iy += h * w ** 3 / 12 + a * rx * rx;        // bending about y (vertical):   integra x²
    xmin = Math.min(xmin, r.x0); xmax = Math.max(xmax, r.x1);
    ymin = Math.min(ymin, r.y0); ymax = Math.max(ymax, r.y1);
  }
  // Área a un lado de un corte horizontal y=yc / vertical x=xc.
  const areaBelowY = yc => { let s = 0; for (const r of rects) { const lo = Math.min(Math.max(yc, r.y0), r.y1); s += (r.x1 - r.x0) * (lo - r.y0); } return s; };
  const areaLeftX = xc => { let s = 0; for (const r of rects) { const lo = Math.min(Math.max(xc, r.x0), r.x1); s += (r.y1 - r.y0) * (lo - r.x0); } return s; };
  const bisect = (f, lo, hi, target) => { for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; (f(m) < target ? lo = m : hi = m); } return (lo + hi) / 2; };
  const yp = bisect(areaBelowY, ymin, ymax, A / 2);
  const xp = bisect(areaLeftX, xmin, xmax, A / 2);
  // ∫|y−yp| dA y ∫|x−xp| dA (momento plástico = módulo plástico).
  const seg = (a, b, p, w) => {                 // ∫_a^b |t−p|·w dt
    if (p <= a) return w * ((b * b - a * a) / 2 - p * (b - a));
    if (p >= b) return w * (p * (b - a) - (b * b - a * a) / 2);
    const left = w * (p * (p - a) - (p * p - a * a) / 2);
    const right = w * ((b * b - p * p) / 2 - p * (b - p));
    return left + right;
  };
  let Zz = 0, Zy = 0;
  for (const r of rects) { Zz += seg(r.y0, r.y1, yp, r.x1 - r.x0); Zy += seg(r.x0, r.x1, xp, r.y1 - r.y0); }
  const Sz = Iz / Math.max(ymax - cy, cy - ymin);
  const SyV = Iy / Math.max(xmax - cx, cx - xmin);
  return { A, cx, cy, Iz, Iy, Sz, Sy: SyV, Zz, Zy, xmin, xmax, ymin, ymax, h: ymax - ymin, b: xmax - xmin };
}

// Calcula las propiedades geométricas a partir de la forma y dimensiones.
// Devuelve null si la forma no es reconocible con dimensiones (→ usar genérica).
function fromShape(shape, d) {
  const s = String(shape || '').toLowerCase();
  if (s === 'i' || s === 'w' || s === 'wf' || s === 'ipe' || s === 'hea' || s === 'heb') {
    const { d: H, bf, tf, tw } = d;
    if (!(H > 0 && bf > 0 && tf > 0 && tw > 0)) return null;
    const hw = H - 2 * tf;                                   // alma libre
    const A = 2 * bf * tf + hw * tw;
    const Iz = bf * H ** 3 / 12 - (bf - tw) * hw ** 3 / 12;  // fuerte
    const Iy = 2 * (tf * bf ** 3 / 12) + hw * tw ** 3 / 12;  // débil
    const Sz = Iz / (H / 2), Sy = Iy / (bf / 2);
    const Zz = bf * tf * (H - tf) + tw * hw ** 2 / 4;
    const Zy = bf ** 2 * tf / 2 + hw * tw ** 2 / 4;
    const J = (2 * bf * tf ** 3 + (H - tf) * tw ** 3) / 3;   // open thin-walled
    const Cw = Iy * (H - tf) ** 2 / 4;                       // alabeo (I bisimétrico)
    return {
      shape: 'I', A, Iz, Iy, Sz, Sy, Zz, Zy, J, Cw, ho: H - tf,  // ho = distancia c.g. de alas
      Avz_web: hw * tw, Avy_flange: 2 * bf * tf,             // corte por alma / alas
      lambdaFlange: bf / (2 * tf), lambdaWeb: hw / tw,        // b/t ala, h/tw alma
      h: H, b: bf, dmin: Math.min(H, bf),
    };
  }
  if (s === 'rect' || s === 'rectangular' || s === 'r') {
    const { b, h } = d;
    if (!(b > 0 && h > 0)) return null;
    const A = b * h;
    return {
      shape: 'rect', A, Iz: b * h ** 3 / 12, Iy: h * b ** 3 / 12,
      Sz: b * h ** 2 / 6, Sy: h * b ** 2 / 6, Zz: b * h ** 2 / 4, Zy: h * b ** 2 / 4,
      J: rectJ(h, b), Cw: 0, Avz_web: 5 / 6 * A, Avy_flange: 5 / 6 * A,
      lambdaFlange: 0, lambdaWeb: 0, h, b, dmin: Math.min(b, h),
    };
  }
  if (s === 'circle' || s === 'circular' || s === 'round' || s === 'c') {
    const { D } = d;
    if (!(D > 0)) return null;
    const A = Math.PI * D ** 2 / 4, I = Math.PI * D ** 4 / 64;
    return {
      shape: 'circle', A, Iz: I, Iy: I, Sz: Math.PI * D ** 3 / 32, Sy: Math.PI * D ** 3 / 32,
      Zz: D ** 3 / 6, Zy: D ** 3 / 6, J: Math.PI * D ** 4 / 32, Cw: 0,
      Avz_web: 0.9 * A, Avy_flange: 0.9 * A, lambdaFlange: 0, lambdaWeb: 0,
      h: D, b: D, dmin: D,
    };
  }
  if (s === 'pipe' || s === 'tube' || s === 'hss-round' || s === 'chs') {
    const { D, t } = d;
    if (!(D > 0 && t > 0 && t < D / 2)) return null;
    const Di = D - 2 * t;
    const A = Math.PI * (D ** 2 - Di ** 2) / 4, I = Math.PI * (D ** 4 - Di ** 4) / 64;
    return {
      shape: 'pipe', A, Iz: I, Iy: I, Sz: I / (D / 2), Sy: I / (D / 2),
      Zz: (D ** 3 - Di ** 3) / 6, Zy: (D ** 3 - Di ** 3) / 6, J: Math.PI * (D ** 4 - Di ** 4) / 32,
      Cw: 0, Avz_web: 0.5 * A, Avy_flange: 0.5 * A, lambdaFlange: D / t, lambdaWeb: D / t,
      h: D, b: D, dmin: D,
    };
  }
  if (s === 'box' || s === 'hss' || s === 'rhs' || s === 'tube-rect') {
    const { b, h, t } = d;
    if (!(b > 0 && h > 0 && t > 0 && t < Math.min(b, h) / 2)) return null;
    const bi = b - 2 * t, hi = h - 2 * t;
    const A = b * h - bi * hi;
    const Iz = (b * h ** 3 - bi * hi ** 3) / 12, Iy = (h * b ** 3 - hi * bi ** 3) / 12;
    const Am = (b - t) * (h - t);                            // área media (Bredt)
    const J = 2 * t * Am ** 2 / ((b - t) + (h - t));
    return {
      shape: 'box', A, Iz, Iy, Sz: Iz / (h / 2), Sy: Iy / (b / 2),
      Zz: b * h ** 2 / 4 - bi * hi ** 2 / 4, Zy: h * b ** 2 / 4 - hi * bi ** 2 / 4,
      J, Cw: 0, Avz_web: 2 * h * t, Avy_flange: 2 * b * t,
      lambdaFlange: (b - 2 * t) / t, lambdaWeb: (h - 2 * t) / t, h, b, dmin: Math.min(b, h),
    };
  }
  if (s === 'channel' || s === 'u' || s === 'upn' || s === 'c-shape') {
    const { d: H, bf, tf, tw } = d;
    if (!(H > 0 && bf > 0 && tf > 0 && tw > 0 && tw < bf && 2 * tf < H)) return null;
    const p = rectsProps([
      { x0: 0, x1: tw, y0: 0, y1: H },                       // alma (back en x=0)
      { x0: tw, x1: bf, y0: H - tf, y1: H },                 // ala superior
      { x0: tw, x1: bf, y0: 0, y1: tf },                     // ala inferior
    ]);
    const hm = H - tf;                                        // entre c.g. de alas
    const Cw = (hm ** 2 * bf ** 3 * tf / 12) * ((3 * bf * tf + 2 * hm * tw) / (6 * bf * tf + hm * tw));
    const J = (2 * bf * tf ** 3 + H * tw ** 3) / 3;
    return {
      shape: 'channel', A: p.A, Iz: p.Iz, Iy: p.Iy, Sz: p.Sz, Sy: p.Sy, Zz: p.Zz, Zy: p.Zy,
      J, Cw, ho: hm, Avz_web: (H - 2 * tf) * tw, Avy_flange: 2 * bf * tf,
      lambdaFlange: bf / tf, lambdaWeb: (H - 2 * tf) / tw, h: H, b: bf, dmin: Math.min(H, bf),
    };
  }
  if (s === 'angle' || s === 'l' || s === 'l-shape') {
    const { d: H, b: B, t } = d;                              // H = ala vertical, B = ala horizontal
    if (!(H > 0 && B > 0 && t > 0 && t < Math.min(H, B))) return null;
    const p = rectsProps([
      { x0: 0, x1: t, y0: 0, y1: H },                         // ala vertical
      { x0: t, x1: B, y0: 0, y1: t },                         // ala horizontal (sin esquina)
    ]);
    const J = (H * t ** 3 + (B - t) * t ** 3) / 3;            // perfil abierto delgado
    return {
      shape: 'angle', A: p.A, Iz: p.Iz, Iy: p.Iy, Sz: p.Sz, Sy: p.Sy, Zz: p.Zz, Zy: p.Zy,
      J, Cw: 0, Avz_web: H * t, Avy_flange: B * t,            // angular: alabeo despreciable
      lambdaFlange: Math.max(H, B) / t, lambdaWeb: Math.max(H, B) / t, h: H, b: B, dmin: Math.min(H, B),
    };
  }
  if (s === 'tee' || s === 't' || s === 't-shape') {
    const { d: H, bf, tf, tw } = d;
    if (!(H > 0 && bf > 0 && tf > 0 && tw > 0 && tw < bf && tf < H)) return null;
    const p = rectsProps([
      { x0: (bf - tw) / 2, x1: (bf + tw) / 2, y0: 0, y1: H - tf },   // alma (vástago)
      { x0: 0, x1: bf, y0: H - tf, y1: H },                          // ala (cabeza)
    ]);
    const J = (bf * tf ** 3 + (H - tf) * tw ** 3) / 3;
    return {
      shape: 'tee', A: p.A, Iz: p.Iz, Iy: p.Iy, Sz: p.Sz, Sy: p.Sy, Zz: p.Zz, Zy: p.Zy,
      J, Cw: 0, ho: H - tf / 2, Avz_web: (H - tf) * tw, Avy_flange: bf * tf,
      lambdaFlange: bf / (2 * tf), lambdaWeb: (H - tf) / tw, h: H, b: bf, dmin: Math.min(H, bf),
    };
  }
  if (s === 'polygon' || s === 'poly') {
    const outline = d.outline, holes = d.holes || [];
    if (!Array.isArray(outline) || outline.length < 3) return null;
    let p; try { p = polygonProps({ outline, holes }); } catch (e) { return null; }
    // J de torsión: estimación de sección compacta J ≈ A⁴/(40·Ip) (≈ exacta en
    // círculo). Av ≈ 5/6·A (sólida). Cw despreciable. Iyz/principales se exponen.
    const Ip = p.Iz + p.Iy;
    const J = Ip > 0 ? p.A ** 4 / (40 * Ip) : 0;
    return {
      shape: 'polygon', A: p.A, Iz: p.Iz, Iy: p.Iy, Sz: p.Sz, Sy: p.Sy, Zz: p.Zz, Zy: p.Zy,
      J, Cw: 0, Avz_web: 5 / 6 * p.A, Avy_flange: 5 / 6 * p.A,
      lambdaFlange: 0, lambdaWeb: 0, h: p.h, b: p.b, dmin: Math.min(p.h, p.b),
      Iyz: p.Iyz, I1: p.I1, I2: p.I2, theta: p.theta, cx: p.cx, cy: p.cy, perimeter: p.perimeter,
    };
  }
  return null;
}

// Rectángulo equivalente desde A, Iy, Iz (sección genérica de Pórtico).
function fromGeneric(sec, shapeFactor) {
  const A = sec.A || 1e-6;
  const Iz = sec.Iz || sec.Iy || 1e-9, Iy = sec.Iy || sec.Iz || 1e-9;
  const cz = Math.sqrt(Math.max(3 * Iz / A, 1e-12));
  const cy = Math.sqrt(Math.max(3 * Iy / A, 1e-12));
  const Sz = Iz / cz, Sy = Iy / cy;
  const h = 2 * cz, b = A / h;
  const sf = shapeFactor || 1.12;
  return {
    shape: 'generic', A, Iz, Iy, Sz, Sy, Zz: sf * Sz, Zy: sf * Sy,
    J: sec.J || rectJ(h, b), Cw: 0,
    Avz_web: sec.Avy || 0.6 * A, Avy_flange: sec.Avz || 0.6 * A,
    lambdaFlange: 0, lambdaWeb: 0, h, b, dmin: 2 * Math.min(cz, cy),
  };
}

// ── API: resuelve TODAS las propiedades de diseño de una sección ────────────────
// sec: sección del modelo { A, Iz, Iy, J, Avy, Avz, design?:{shape,dims,...overrides} }
// Devuelve un objeto plano con A, Iy, Iz, Sy, Sz, Zy, Zz, ry, rz, rmin, J, Cw,
// Avy, Avz, lambdaFlange, lambdaWeb, h, b, dmin, shape.
export function resolveSectionProps(sec, opts = {}) {
  const dz = sec.design || {};
  // dims pueden venir en design.dims o directamente en design
  const dims = dz.dims || dz;
  let g = dz.shape ? fromShape(dz.shape, dims) : null;
  if (!g) g = fromGeneric(sec, dz.shapeFactor ?? opts.shapeFactor);

  // Para A, Iy, Iz, J: preferir SIEMPRE los valores del modelo (lo que ve el
  // solver) si son válidos, para consistencia análisis↔diseño.
  const A  = sec.A  > 0 ? sec.A  : g.A;
  const Iz = sec.Iz > 0 ? sec.Iz : g.Iz;
  const Iy = sec.Iy > 0 ? sec.Iy : g.Iy;
  const J  = sec.J  > 0 ? sec.J  : g.J;
  // S, Z, Av, Cw se escalan si el A/I del modelo difiere del de la forma (raro).
  const out = {
    shape: g.shape, A, Iz, Iy, J,
    Sz: g.Sz, Sy: g.Sy, Zz: g.Zz, Zy: g.Zy, Cw: g.Cw,
    rz: Math.sqrt(Iz / A), ry: Math.sqrt(Iy / A),
    Avy: sec.Avy > 0 ? sec.Avy : g.Avz_web,        // corte que acompaña a Mz (alma)
    Avz: sec.Avz > 0 ? sec.Avz : g.Avy_flange,     // corte que acompaña a My (alas)
    lambdaFlange: g.lambdaFlange, lambdaWeb: g.lambdaWeb,
    h: g.h, b: g.b, dmin: g.dmin, ho: g.ho || 0,
  };
  // Propiedades extra de secciones poligonales (producto de inercia, principales).
  for (const k of ['Iyz', 'I1', 'I2', 'theta', 'cx', 'cy', 'perimeter']) if (g[k] !== undefined) out[k] = g[k];
  // Armadura de H.A. (barras/estribos) se propaga para el diseño de hormigón (#70).
  if (dz.rebar) out.rebar = dz.rebar;
  out.rmin = Math.min(out.rz, out.ry);
  // Overrides explícitos del usuario (design.Zz, design.Cw, etc.)
  for (const k of ['Sz', 'Sy', 'Zz', 'Zy', 'Cw', 'Avy', 'Avz', 'rz', 'ry', 'lambdaFlange', 'lambdaWeb']) {
    if (typeof dz[k] === 'number' && dz[k] > 0) out[k] = dz[k];
  }
  out.rmin = Math.min(out.rz, out.ry);
  return out;
}

export { rectJ, fromShape, fromGeneric };
