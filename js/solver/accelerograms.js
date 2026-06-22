// ──────────────────────────────────────────────────────────────────────────────
// accelerograms.js — Entrada de acelerograma para el análisis time-history (#48c).
//
// (1) PARSER de un registro pegado/cargado: acepta dos columnas (t, a) o una sola
//     columna (a) con Δt dado. Devuelve { dt, a:Float64Array, n, dur }.
// (2) Generadores de señales de DEMOSTRACIÓN **sintéticas** (claramente rotuladas
//     como tales — NO son registros reales): pulso de Ricker, armónico y un sismo
//     sintético (ruido de banda con envolvente de Saragoni–Hart). Para usar los
//     registros reales (p.ej. Llolleo/Constitución 2010) el usuario los pega o
//     carga como texto (t a) — no se incluyen por no disponer de la serie digital.
//
// Unidad de aceleración: m/s² (si el registro viene en g, multiplíquese por 9.81
// con el factor de escala del diálogo).
// ──────────────────────────────────────────────────────────────────────────────

export const G = 9.80665;   // m/s² por g

// ── Parser de texto a registro ────────────────────────────────────────────────
// `text`: filas con 1 o 2 números (separados por espacios, coma, tab o ;).
// Una columna → se usa `dtFallback` (s). Dos columnas → (t, a) y Δt = mediana de Δt.
// Devuelve { ok, dt, a, n, dur, cols, note }.
export function parseAccelerogram(text, dtFallback = 0.01) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#%/]/.test(line) || /[a-df-zA-DF-Z]/.test(line.replace(/[eE][+-]?\d/g, ''))) continue; // salta cabeceras/texto (deja notación E)
    const nums = line.split(/[\s,;]+/).map(Number).filter(v => Number.isFinite(v));
    if (nums.length) rows.push(nums);
  }
  if (rows.length < 2) return { ok: false, note: 'No se reconocieron ≥ 2 muestras numéricas.' };

  const cols = Math.min(...rows.map(r => r.length)) >= 2 ? 2 : 1;
  let dt, a;
  if (cols >= 2) {
    const t = rows.map(r => r[0]), av = rows.map(r => r[1]);
    const dts = []; for (let i = 1; i < t.length; i++) dts.push(t[i] - t[i - 1]);
    dts.sort((p, q) => p - q);
    dt = dts[Math.floor(dts.length / 2)] || dtFallback;   // mediana (robusta a saltos)
    a = Float64Array.from(av);
  } else {
    dt = dtFallback;
    a = Float64Array.from(rows.map(r => r[0]));
  }
  if (!(dt > 0) || !isFinite(dt)) return { ok: false, note: 'Δt no válido.' };
  return { ok: true, dt, a, n: a.length, dur: (a.length - 1) * dt, cols };
}

// ── Estadísticos de un registro ───────────────────────────────────────────────
export function accStats(a, dt) {
  let pga = 0, sum2 = 0;
  for (const v of a) { const m = Math.abs(v); if (m > pga) pga = m; sum2 += v * v; }
  const rms = Math.sqrt(sum2 / a.length);
  // Intensidad de Arias ≈ (π/2g)·∫a²dt
  const arias = Math.PI / (2 * G) * sum2 * dt;
  return { pga, rms, arias, dur: (a.length - 1) * dt, n: a.length };
}

// Escala un registro a un PGA objetivo (m/s²). Devuelve una copia.
export function scaleToPGA(a, targetPGA) {
  let pga = 0; for (const v of a) pga = Math.max(pga, Math.abs(v));
  const f = pga > 0 ? targetPGA / pga : 1;
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * f;
  return out;
}

// ── PRNG determinista (mulberry32) para el sismo sintético reproducible ───────
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Generadores de DEMOSTRACIÓN (sintéticos) ──────────────────────────────────
// Pulso de Ricker (segunda derivada de la gaussiana). fp = frecuencia pico [Hz].
export function ricker({ fp = 2, pga = 3, dt = 0.005, dur = 6 } = {}) {
  const n = Math.round(dur / dt) + 1, a = new Float64Array(n);
  const t0 = 1.0 / fp;   // centra el pulso
  for (let i = 0; i < n; i++) {
    const t = i * dt - t0, x = Math.PI * fp * t, x2 = x * x;
    a[i] = (1 - 2 * x2) * Math.exp(-x2);
  }
  return { name: `Pulso de Ricker (fp=${fp} Hz) · sintético`, dt, a: scaleToPGA(a, pga), synthetic: true };
}

// Armónico con envolvente suave (resonancia controlada). freq [Hz].
export function harmonic({ freq = 1, pga = 2, dt = 0.005, dur = 12 } = {}) {
  const n = Math.round(dur / dt) + 1, a = new Float64Array(n), w = 2 * Math.PI * freq;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const env = Math.min(1, t / 1.5) * Math.min(1, (dur - t) / 1.5);   // rampa entrada/salida
    a[i] = Math.max(0, env) * Math.sin(w * t);
  }
  return { name: `Armónico (${freq} Hz) · sintético`, dt, a: scaleToPGA(a, pga), synthetic: true };
}

// Sismo sintético: ruido de banda con envolvente de Saragoni–Hart (subida-meseta-
// caída). NO es un registro real; sirve de demo reproducible (seed).
export function syntheticSeismic({ pga = 3, dt = 0.01, dur = 20, seed = 12345 } = {}) {
  const n = Math.round(dur / dt) + 1, raw = new Float64Array(n), rnd = mulberry32(seed);
  // ruido blanco → suavizado leve (promedio móvil) para limitar la banda alta
  for (let i = 0; i < n; i++) raw[i] = rnd() * 2 - 1;
  const a = new Float64Array(n);
  const tRise = 0.15 * dur, tLevel = 0.45 * dur, decay = 2.5 / dur;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    let env;
    if (t < tRise) env = (t / tRise) ** 2;
    else if (t < tLevel) env = 1;
    else env = Math.exp(-decay * (t - tLevel) * 4);
    // suavizado 3 puntos
    const s = (raw[Math.max(0, i - 1)] + 2 * raw[i] + raw[Math.min(n - 1, i + 1)]) / 4;
    a[i] = env * s;
  }
  return { name: 'Sismo sintético (ruido de banda) · NO es un registro real', dt, a: scaleToPGA(a, pga), synthetic: true };
}

// Catálogo de presets de demostración (para el diálogo).
export const DEMO_PRESETS = {
  ricker:    () => ricker(),
  harmonic:  () => harmonic(),
  synthetic: () => syntheticSeismic(),
};
