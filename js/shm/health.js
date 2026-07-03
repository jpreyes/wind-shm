// ─────────────────────────────────────────────────────────────────────────────
// health.js — Frente 2 · R-35 · Índice de Salud unificado (Health Index).
//
// Fusiona las 4 fuentes de estado de una torre en un HI 0–100 (100 = sana), con
// el desglose de contribuciones. Resuelve la incoherencia actual: el clasificador
// ML podía decir «sin daño» mientras el gemelo (R-31) marca base defectuosa o la
// fatiga está consumida — el HI las combina en un solo número coherente.
//
// Fuentes (cualquier subconjunto; ausente = no penaliza ni pondera):
//   cls  : clase ML de daño 0–4          (0 = sano)
//   insp : score de inspección 0–100     (0 = sin hallazgos, 100 = crítico)
//   fat  : fracción de vida de fatiga 0–1 consumida
//   twin : defecto del gemelo 0–1         (0 = en banda, 1 = fuera de banda)
//
// Módulo ES puro → verificable en Node.  node js/shm/health.js
// ─────────────────────────────────────────────────────────────────────────────

export const HI_WEIGHTS = { cls: 0.35, insp: 0.30, fat: 0.20, twin: 0.15 };
export const HI_LABEL = { cls: 'Clasificador ML', insp: 'Inspección', fat: 'Fatiga', twin: 'Gemelo (f₁)' };

const clamp = (v, hi = 1) => Math.max(0, Math.min(hi, v));

/**
 * @param {{cls?:number, insp?:number, fat?:number, twin?:number}} inputs
 * @returns {{hi:number|null, band:string, contributions:Array<{source,penalty,weight,share}>}}
 *   `penalty` 0–100 por fuente; `share` = aporte a la baja del HI (suma ≈ 100−HI).
 */
export function computeHealth(inputs = {}) {
  const pen = {};
  if (typeof inputs.cls === 'number') pen.cls = clamp(inputs.cls / 4) * 100;
  if (typeof inputs.insp === 'number') pen.insp = clamp(inputs.insp, 100);
  if (typeof inputs.fat === 'number') pen.fat = clamp(inputs.fat) * 100;
  if (typeof inputs.twin === 'number') pen.twin = clamp(inputs.twin) * 100;

  const keys = Object.keys(pen);
  if (!keys.length) return { hi: null, band: 'unknown', contributions: [] };

  let wsum = 0, wpen = 0, worst = 0;
  for (const k of keys) { const w = HI_WEIGHTS[k]; wsum += w; wpen += w * pen[k]; if (pen[k] > worst) worst = pen[k]; }
  const avg = wpen / wsum;
  // «Worst-aware»: una fuente crítica arrastra el HI aunque el resto esté sano.
  const penalty = 0.6 * avg + 0.4 * worst;
  const hi = Math.round(100 - penalty);

  const contributions = keys.map(k => ({
    source: k, penalty: Math.round(pen[k]), weight: HI_WEIGHTS[k],
    // aporte de cada fuente a la baja total (para el tooltip de desglose)
    share: Math.round(pen[k] * (0.6 * HI_WEIGHTS[k] / wsum + 0.4 * (pen[k] === worst ? 1 : 0)) * 10) / 10,
  })).sort((a, b) => b.penalty - a.penalty);

  return { hi, band: healthBand(hi), contributions };
}

/** Tramo de salud desde el HI (mismos nombres que las condiciones de inspección). */
export function healthBand(hi) {
  return hi == null ? 'unknown' : hi >= 70 ? 'operativa' : hi >= 40 ? 'observacion' : 'critica';
}

/** Color del HI (coherente con la paleta de condición). */
export function healthColor(hi) {
  const b = healthBand(hi);
  return b === 'critica' ? '#ef4444' : b === 'observacion' ? '#f59e0b' : b === 'operativa' ? '#22c55e' : '#94a3b8';
}

// ── Autoverificación (node js/shm/health.js) ──────────────────────────────────
if (typeof process !== 'undefined' && import.meta.url.endsWith((process.argv?.[1] || '').replace(/\\/g, '/'))) {
  const eq = (a, b, m) => console.log((a === b ? '✓' : '✗') + ' ' + m + ` (${a} vs ${b})`);
  eq(computeHealth({ cls: 0, insp: 0, fat: 0, twin: 0 }).hi, 100, 'todo sano → 100');
  eq(computeHealth({ cls: 4, insp: 100, fat: 1, twin: 1 }).hi, 0, 'todo crítico → 0');
  eq(computeHealth({}).hi, null, 'sin fuentes → null');
  const w = computeHealth({ cls: 0, insp: 0, fat: 0, twin: 1 });  // solo el gemelo crítico
  console.log((w.hi < 60 ? '✓' : '✗') + ` worst-aware: una fuente crítica baja el HI (${w.hi})`);
  const only = computeHealth({ insp: 50 });
  console.log((only.hi === 50 ? '✓' : '✗') + ` fuente única: HI = 100−penalty (${only.hi})`);
  const c = computeHealth({ cls: 2, insp: 40, fat: 0.1 });
  console.log('desglose:', JSON.stringify(c.contributions.map(x => x.source + ':' + x.penalty)));
  console.log('band(85)=', healthBand(85), 'band(50)=', healthBand(50), 'band(20)=', healthBand(20));
}
