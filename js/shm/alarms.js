// ─────────────────────────────────────────────────────────────────────────────
// alarms.js — Frente 2 · R-23a · alarmas configurables (client-side).
//
// Umbrales por métrica (RMS, desviación de f₁, viento) en localStorage + registro
// de eventos + evaluación por estructura. La notificación email/SMS y las reglas
// en servidor son R-23b (Fase 3, con backend). Módulo ES puro → testeable en Node.
//   node js/shm/alarms.js
// ─────────────────────────────────────────────────────────────────────────────
const KEY = 'rewind.alarms.v1';
const LOG_KEY = 'rewind.alarmlog.v1';
const _ls = typeof localStorage !== 'undefined' ? localStorage : null;

// Umbrales por defecto. rms en mg (milli-g), df1 en % de desviación, wind en m/s.
export const DEFAULTS = { rmsWarn: 30, rmsCrit: 45, df1Warn: 3, df1Crit: 6, windCrit: 25 };
export const METRIC_LABEL = { rms: 'RMS', df1: 'Δf₁', wind: 'Viento' };

export function getThresholds() {
  try { return { ...DEFAULTS, ...(JSON.parse(_ls?.getItem(KEY)) || {}) }; } catch { return { ...DEFAULTS }; }
}
export function setThresholds(th) { try { _ls?.setItem(KEY, JSON.stringify(th)); } catch { /* */ } }
export function resetThresholds() { try { _ls?.removeItem(KEY); } catch { /* */ } }

/**
 * Evalúa un resumen contra los umbrales.
 * @returns {Array<{metric, level:'warn'|'crit', value, th}>}
 */
export function evaluate(sum, base, th = getThresholds()) {
  if (!sum || sum.standby) return [];
  const out = [];
  const rmsMg = (sum.rms || 0) * 1000;
  if (rmsMg >= th.rmsCrit) out.push({ metric: 'rms', level: 'crit', value: rmsMg, th: th.rmsCrit });
  else if (rmsMg >= th.rmsWarn) out.push({ metric: 'rms', level: 'warn', value: rmsMg, th: th.rmsWarn });
  if (base && typeof sum.f1 === 'number') {
    const dev = Math.abs((sum.f1 - base) / base * 100);
    if (dev >= th.df1Crit) out.push({ metric: 'df1', level: 'crit', value: dev, th: th.df1Crit });
    else if (dev >= th.df1Warn) out.push({ metric: 'df1', level: 'warn', value: dev, th: th.df1Warn });
  }
  if (sum.wind != null && sum.wind >= th.windCrit) out.push({ metric: 'wind', level: 'crit', value: sum.wind, th: th.windCrit });
  return out;
}

// Nivel peor de una lista de alarmas ('crit' > 'warn' > null).
export function worstLevel(alarms) {
  if (alarms.some(a => a.level === 'crit')) return 'crit';
  if (alarms.some(a => a.level === 'warn')) return 'warn';
  return null;
}

// ── Registro de eventos ───────────────────────────────────────────────────────
export function logEvent(ev) {
  try {
    const log = JSON.parse(_ls?.getItem(LOG_KEY)) || [];
    log.push(ev); while (log.length > 200) log.shift();
    _ls?.setItem(LOG_KEY, JSON.stringify(log));
  } catch { /* */ }
}
export function getLog() { try { return JSON.parse(_ls?.getItem(LOG_KEY)) || []; } catch { return []; } }
export function clearLog() { try { _ls?.removeItem(LOG_KEY); } catch { /* */ } }

// ── Autoverificación (node js/shm/alarms.js) ──────────────────────────────────
if (typeof process !== 'undefined' && import.meta.url.endsWith((process.argv?.[1] || '').replace(/\\/g, '/'))) {
  const ok = (c, m) => console.log((c ? '✓' : '✗') + ' ' + m);
  const th = DEFAULTS;
  ok(evaluate({ rms: 0.02, f1: 0.30 }, 0.30, th).length === 0, 'todo dentro de umbral → sin alarmas');
  const a1 = evaluate({ rms: 0.05, f1: 0.30 }, 0.30, th);   // 50 mg > 45 crit
  ok(a1.some(a => a.metric === 'rms' && a.level === 'crit'), `RMS 50mg → crit (${JSON.stringify(a1)})`);
  const a2 = evaluate({ rms: 0.02, f1: 0.28 }, 0.30, th);   // -6.7% > 6 crit
  ok(a2.some(a => a.metric === 'df1' && a.level === 'crit'), `Δf₁ -6.7% → crit`);
  ok(evaluate({ rms: 0.05, standby: true }, 0.30, th).length === 0, 'standby → sin alarmas');
  ok(worstLevel(a1) === 'crit', 'worstLevel');
}
