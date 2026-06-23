// ──────────────────────────────────────────────────────────────────────────────
// serviceability.js — Estados límite de SERVICIO por norma (#68).
//
// Límites de FLECHA (deflexión) y DERIVA (interstory drift) según el código de
// diseño. Independiente del análisis: recibe la flecha o la deriva calculada y la
// compara con el límite normativo, devolviendo el ratio demanda/límite.
//
//   · Flecha:  límite = L / divisor   (voladizo → luz efectiva 2·L)
//       IBC/AISC (Tabla 1604.3): sobrecarga L/360, total D+L L/240, techo L/180
//       EN 1990 (A1.4):          δmax (total) L/250, δ2 (variable) L/300
//       NCh (práctica):          sobrecarga L/360, total L/300
//   · Deriva (Δ/h) admisible:
//       NCh433/DS61: 0.002 (en el c.m.)      · ASCE7/IBC: 0.020 (Cat. II)
//       Eurocódigo 8: 0.010 (no estruct. desacoplado)
//
// Unidades: longitudes en m (coherentes); los ratios son adimensionales.
// ──────────────────────────────────────────────────────────────────────────────

// divisor de flecha (límite = L/divisor) por código y uso.
const DEFLECTION = {
  'AISC360-16:LRFD': { live: 360, total: 240, roof: 180 },
  'AISC360-16:ASD':  { live: 360, total: 240, roof: 180 },
  'IBC':             { live: 360, total: 240, roof: 180 },
  'EN1993-1-1':      { live: 300, total: 250, roof: 250 },
  'EN1999-1-1':      { live: 300, total: 250, roof: 250 },
  'EN1992-1-1':      { live: 300, total: 250, roof: 250 },
  'ACI318-19':       { live: 360, total: 240, roof: 240 },
  'NCh1198':         { live: 300, total: 300, roof: 300 },
  'NCh':             { live: 360, total: 300, roof: 300 },
  _default:          { live: 360, total: 240, roof: 240 },
};

// deriva de entrepiso admisible (Δ/h) por código.
const DRIFT = {
  'NCh433':   0.002,   // DS61, relativa al centro de masas
  'ASCE7':    0.020,   // Cat. de riesgo II (la más común)
  'IBC':      0.020,
  'EN1998':   0.010,   // EC8, no estructural desacoplado
  'EC8':      0.010,
  _default:   0.020,
};

// Divisor de flecha (límite = L/divisor) para un código y uso.
export function deflectionDivisor(code, use = 'live') {
  const t = DEFLECTION[code] || DEFLECTION._default;
  return t[use] ?? t.live;
}

/**
 * Chequeo de flecha de servicio.
 * @param {object} o { delta (m, flecha real), L (m, luz), code, use='live'|'total'|'roof',
 *                     cantilever=false, divisor (override directo) }
 * @returns { demanda, limite, ratio, divisor, luzEfectiva, formula }
 */
export function checkDeflection({ delta, L, code, use = 'live', cantilever = false, divisor }) {
  const div = divisor || deflectionDivisor(code, use);
  const Lef = cantilever ? 2 * L : L;          // voladizo: luz efectiva 2L
  const limite = Lef / div;
  const d = Math.abs(delta);
  return {
    demanda: +d.toFixed(6), limite: +limite.toFixed(6),
    ratio: limite > 1e-12 ? +(d / limite).toFixed(4) : Infinity,
    divisor: div, luzEfectiva: +Lef.toFixed(4),
    formula: `δ ≤ ${cantilever ? '2·L' : 'L'}/${div} (servicio ${use}, ${code || 'def.'})`,
  };
}

// Deriva de entrepiso admisible (Δ/h) por código.
export function driftLimit(code) { return DRIFT[code] ?? DRIFT._default; }

/**
 * Chequeo de deriva de entrepiso.
 * @param {object} o { drift (m, deriva relativa), h (m, altura de entrepiso),
 *                     code='NCh433'|'ASCE7'|'EC8', allow (override del límite Δ/h) }
 * @returns { demanda (Δ/h), limite (Δ/h), ratio, formula }
 */
export function checkDrift({ drift, h, code = 'NCh433', allow }) {
  const lim = allow ?? driftLimit(code);
  const ratio = h > 1e-12 ? Math.abs(drift) / h : 0;
  return {
    demanda: +ratio.toFixed(5), limite: +lim.toFixed(5),
    ratio: lim > 1e-12 ? +(ratio / lim).toFixed(4) : Infinity,
    formula: `Δ/h ≤ ${lim} (${code})`,
  };
}
