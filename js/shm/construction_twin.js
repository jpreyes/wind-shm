// ─────────────────────────────────────────────────────────────────────────────
// construction_twin.js — Gemelo de CONSTRUCCIÓN (R-31, buque insignia).
//
// Mientras la torre se erige, predice la f₁ que DEBERÍA tener en cada etapa de
// montaje y la compara con lo medido → detecta defectos de obra antes de la puesta
// en marcha (base flexible, pernos sin pretensar, grout, asentamiento) y captura la
// línea base de commissioning.
//
// Física: la torre es un voladizo con masa distribuida + masa de punta (RNA). A
// medio montar es más corto y rígido → f₁ alta; al subir tramos y montar góndola/
// rotor, f₁ baja por una curva monótona. Modelo equivalente (Rayleigh) CALIBRADO a
// la f₁ del gemelo FEM de la torre completa, así la curva pasa por ese punto.
// Módulo ES puro → verificable en Node.
// ─────────────────────────────────────────────────────────────────────────────

export const H = 90;            // altura de buje (m), = TOWER_H
export const MU = 5000;         // masa distribuida del fuste (kg/m), acero cónico ~3 MW
export const M_NAC = 130000;    // masa de góndola (kg)
export const M_ROT = 70000;     // masa de rotor + buje (kg)
const RAYLEIGH = 0.236;         // masa modal equivalente de un voladizo en la punta (33/140)

// Etapas de montaje (orden real) con la longitud erigida y la masa de punta.
export const STAGES = [
  { key: 'fuste25', label: 'Fuste 25%', L: 0.25 * H, M: 0 },
  { key: 'fuste50', label: 'Fuste 50%', L: 0.50 * H, M: 0 },
  { key: 'fuste75', label: 'Fuste 75%', L: 0.75 * H, M: 0 },
  { key: 'fuste',   label: 'Fuste 100%', L: H, M: 0 },
  { key: 'gondola', label: '+ Góndola', L: H, M: M_NAC },
  { key: 'rotor',   label: '+ Rotor', L: H, M: M_NAC + M_ROT },
];

// f₁ (Hz) de un voladizo de largo L con masa de punta M y rigidez EI; kTheta =
// rigidez rotacional de la base (∞ = empotramiento perfecto; finita = base flexible).
export function f1At(L, M, EI, kTheta = Infinity) {
  const m = MU * L, meff = M + RAYLEIGH * m;
  const flex = (L * L * L) / (3 * EI) + (isFinite(kTheta) ? (L * L) / kTheta : 0);   // flexibilidad de punta
  const k = 1 / flex;
  return Math.sqrt(k / meff) / (2 * Math.PI);
}

// Calibra EI para que f₁(torre completa, base rígida) == f₁ del gemelo FEM.
export function calibrateEI(f1Full) {
  const meff = (M_NAC + M_ROT) + RAYLEIGH * MU * H;
  const w = 2 * Math.PI * f1Full;
  const k = w * w * meff;                 // rigidez de punta equivalente
  return (k * H * H * H) / 3;             // EI desde k = 3EI/L³ (base rígida)
}

/** Curva predicha de f₁ por etapa (base nominal rígida). */
export function predictedCurve(f1Full) {
  const EI = calibrateEI(f1Full);
  return { EI, points: STAGES.map(s => ({ ...s, f1: f1At(s.L, s.M, EI) })) };
}

// Ventana soft-stiff: f₁ debe quedar ≥10% por sobre 1P y ≤10% por debajo de 3P
// (1P = giro del rotor, 3P = paso de aspas) para evitar resonancia.
export function softStiffWindow(rpm = 14) {
  const p1 = rpm / 60, p3 = 3 * p1;
  return { rpm, p1, p3, lo: 1.1 * p1, hi: 0.9 * p3 };
}
export const inBand = (f1, w) => f1 >= w.lo && f1 <= w.hi;

// Determinista 0..1 desde un id (para simular defectos estables por torre).
const hash01 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000) / 1000; };

// ¿Cuántas etapas de montaje alcanzó la torre? (desde los % de sus partidas
// fundacion[0]·fuste[1]·gondola[2]·rotor[3]).
export function reachedIndex(stages) {
  if (!stages || !stages.length) return 0;
  const pct = (i) => (stages[i]?.pct ?? 0);
  const fuste = pct(1), gondola = pct(2), rotor = pct(3);
  let n = 0;
  if (fuste >= 25) n = 1; if (fuste >= 50) n = 2; if (fuste >= 75) n = 3; if (fuste >= 100) n = 4;
  if (n >= 4 && gondola >= 100) n = 5;
  if (n >= 5 && rotor >= 100) n = 6;
  return n;   // 0..6 (índice = nº de puntos medidos disponibles)
}

/**
 * Curva MEDIDA simulada hasta la etapa alcanzada. Un subconjunto de torres tiene un
 * «defecto» de base (rigidez rotacional reducida) → la f₁ medida cae por debajo de la
 * banda predicha en las etapas avanzadas (detección temprana). Determinista por id.
 * @returns { defect:boolean, points:[{...stage, f1, predicted, below}] }
 */
export function measuredCurve(f1Full, stages, id = '') {
  const EI = calibrateEI(f1Full);
  const reached = reachedIndex(stages);
  const h = hash01(id);
  const defect = h > 0.7;                                   // ~30% con base flexible
  const kTheta = defect ? (3 * EI / (H * H * H)) * H * (1.2 + 2 * h) : Infinity;  // base blanda (defecto) vs rígida
  const noise = (i) => (hash01(id + i) - 0.5) * 0.012;     // ±0.6% ruido de medición
  const points = [];
  for (let i = 0; i < reached; i++) {
    const s = STAGES[i];
    const pred = f1At(s.L, s.M, EI);
    const meas = f1At(s.L, s.M, EI, kTheta) * (1 + noise(i));
    points.push({ ...s, f1: meas, predicted: pred, below: meas < pred * 0.97 });
  }
  return { defect, reached, points };
}

// ── Autoverificación (node js/shm/construction_twin.js) ───────────────────────
if (typeof process !== 'undefined' && import.meta.url.endsWith((process.argv?.[1] || '').replace(/\\/g, '/'))) {
  const f1Full = 0.283;
  const EI = calibrateEI(f1Full);
  // 1) la curva pasa por la f₁ FEM en la última etapa (rotor montado)
  const cur = predictedCurve(f1Full);
  const last = cur.points[cur.points.length - 1].f1;
  console.log('f₁ etapa final:', last.toFixed(4), '(esperado ≈', f1Full + ')');
  // 2) monotonía decreciente
  const mono = cur.points.every((p, i) => i === 0 || p.f1 <= cur.points[i - 1].f1 + 1e-9);
  console.log('curva monótona decreciente:', mono);
  console.log('curva:', cur.points.map(p => `${p.label}=${p.f1.toFixed(3)}`).join(' · '));
  // 3) validación contra el voladizo analítico SIN masa de punta: f₁ = (β²/2π)√(EI/μ)/L², β=1.875104
  const L = 60, beta2 = 1.875104 ** 2;
  const analytic = (beta2 / (2 * Math.PI)) * Math.sqrt(EI / MU) / (L * L);
  const model = f1At(L, 0, EI);
  const err = Math.abs(model - analytic) / analytic;
  console.log('voladizo desnudo modelo vs analítico:', model.toFixed(4), analytic.toFixed(4), '· err', (err * 100).toFixed(2) + '%');
  // 4) ventana soft-stiff
  const w = softStiffWindow(14);
  console.log('soft-stiff [', w.lo.toFixed(3), ',', w.hi.toFixed(3), '] · f₁ en banda:', inBand(f1Full, w));
  const ok = Math.abs(last - f1Full) < 1e-3 && mono && err < 0.02;
  console.log(ok ? 'OK ✓' : 'FALLA ✗');
}
