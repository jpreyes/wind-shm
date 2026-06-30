// ─────────────────────────────────────────────────────────────────────────────
// fatigue.js — NÚCLEO DE FATIGA (ReWind · R-22).
//
// Consumo de vida a fatiga del fuste/uniones de la torre:
//   · conteo rainflow (ASTM E1049, método de 3 puntos),
//   · curvas S-N bilineales EN 1993-1-9 (categoría de detalle ΔσC),
//   · daño acumulado de Palmgren-Miner → vida remanente (RUL),
//   · DEL — rango/carga equivalente de daño (a una pendiente m de referencia).
//
// Módulo ES PURO (sin DOM ni Three.js): se usa en el navegador y se VERIFICA en
// Node contra soluciones analíticas (ver js/shm/test_fatigue.mjs).
//
// Hoy la historia de tensiones es SINTÉTICA y determinista (firma de fatiga de
// una torre: turbulencia de banda baja + armónicos 1P/3P del rotor). Cuando se
// conecten los sensores reales (galga/acelerómetro) se sustituye `series` por la
// tensión medida/derivada y el resto del núcleo no cambia.
// ─────────────────────────────────────────────────────────────────────────────

// ── Rainflow (ASTM E1049) — port del algoritmo de iamlikeme/rainflow ──────────

// Puntos de retorno (picos y valles): elimina repetidos y tramos monótonos.
export function reversals(series) {
  const x = [];
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (x.length === 0 || v !== x[x.length - 1]) x.push(v);   // descarta repetidos
  }
  if (x.length < 3) return x.slice();
  const out = [x[0]];
  for (let i = 1; i < x.length - 1; i++) {
    const d1 = x[i] - x[i - 1], d2 = x[i + 1] - x[i];
    if (d1 * d2 < 0) out.push(x[i]);                          // cambia de signo → extremo
  }
  out.push(x[x.length - 1]);
  return out;
}

// Extrae ciclos {range, mean, count} (count = 0.5 medio · 1.0 completo) por el
// método de 3 puntos sobre la pila de retornos.
export function extractCycles(series) {
  const pts = reversals(series);
  const stack = [];
  const cycles = [];
  for (let k = 0; k < pts.length; k++) {
    stack.push(pts[k]);
    while (stack.length >= 3) {
      const n = stack.length;
      const x1 = stack[n - 3], x2 = stack[n - 2], x3 = stack[n - 1];
      const X = Math.abs(x3 - x2), Y = Math.abs(x2 - x1);
      if (X < Y) break;                                       // el último rango no cierra
      if (stack.length === 3) {                               // Y = medio ciclo
        cycles.push({ range: Y, mean: 0.5 * (stack[0] + stack[1]), count: 0.5 });
        stack.shift();
      } else {                                                // Y = ciclo completo
        cycles.push({ range: Y, mean: 0.5 * (x1 + x2), count: 1.0 });
        const last = stack.pop(); stack.pop(); stack.pop(); stack.push(last);
      }
    }
  }
  // Residuo: medios ciclos entre retornos consecutivos.
  for (let i = 0; i + 1 < stack.length; i++)
    cycles.push({ range: Math.abs(stack[i] - stack[i + 1]), mean: 0.5 * (stack[i] + stack[i + 1]), count: 0.5 });
  return cycles;
}

// Agrupa el conteo por rango. Si `binSize>0`, agrupa por bins de ese ancho
// (etiqueta = límite superior del bin); útil para el espectro de carga.
export function countCycles(series, binSize = 0) {
  const cycles = Array.isArray(series) && series.length && typeof series[0] === 'object'
    ? series : extractCycles(series);
  const map = new Map();
  for (const c of cycles) {
    const key = binSize ? Math.ceil((c.range || 1e-12) / binSize) * binSize : c.range;
    map.set(key, (map.get(key) || 0) + c.count);
  }
  return [...map.entries()].map(([range, count]) => ({ range, count })).sort((a, b) => a.range - b.range);
}

// ── Curva S-N (EN 1993-1-9, bilineal) ─────────────────────────────────────────

// Categorías de detalle EN 1993-1-9 (ΔσC en MPa a Nc=2·10⁶). Subconjunto útil
// para torres tubulares soldadas y uniones de celosía.
export const SN_DETAILS = [160, 140, 125, 112, 100, 90, 80, 71, 63, 56, 50, 45, 40, 36];

// Ciclos a la falla N para un rango de tensión Δσ (MPa). Curva bilineal:
//   m1=3 hasta ΔσD (5·10⁶, límite de fatiga a amplitud constante),
//   m2=5 hasta ΔσL (10⁸, límite de truncamiento) → bajo ΔσL no hay daño.
export function snN(dsr, detail = 80) {
  const Nc = 2e6, ND = 5e6, NL = 1e8, m1 = 3, m2 = 5, dsC = detail;
  const dsD = dsC * Math.pow(Nc / ND, 1 / m1);   // límite a amplitud constante
  const dsL = dsD * Math.pow(ND / NL, 1 / m2);   // corte (truncamiento)
  if (dsr <= 0) return Infinity;
  if (dsr >= dsD) return Nc * Math.pow(dsC / dsr, m1);
  if (dsr >= dsL) return ND * Math.pow(dsD / dsr, m2);
  return Infinity;                               // bajo el corte → vida infinita
}

// Umbrales de una categoría de detalle (para dibujar/anotar la curva).
export function snLimits(detail = 80) {
  const Nc = 2e6, ND = 5e6, NL = 1e8;
  const dsD = detail * Math.pow(Nc / ND, 1 / 3);
  const dsL = dsD * Math.pow(ND / NL, 1 / 5);
  return { dsC: detail, dsD, dsL, Nc, ND, NL };
}

// ── Daño de Miner y DEL ───────────────────────────────────────────────────────

// Daño acumulado D = Σ nᵢ/Nᵢ para una lista de ciclos {range,count}.
export function minerDamage(cycles, detail = 80) {
  let D = 0;
  for (const c of cycles) { const N = snN(c.range, detail); if (isFinite(N)) D += c.count / N; }
  return D;
}

// Rango equivalente de daño (DEL): el rango constante que, repetido Neq veces,
// produce el mismo Σ n·Δσᵐ. Depende solo de la pendiente m, no de la curva S-N.
export function del(cycles, m = 3, Neq = 2e6) {
  let s = 0; for (const c of cycles) s += c.count * Math.pow(c.range, m);
  return Math.pow(s / Neq, 1 / m);
}

// ── Síntesis de la historia de tensiones (determinista, hasta tener sensores) ──

function hash01(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gauss(rnd) {
  let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Historia representativa de tensión en la base (MPa) sobre una ventana corta:
// turbulencia AR(1) de banda baja (rangos grandes, pocos ciclos) + armónicos
// 1P/3P del rotor (rangos menores, MUCHOS ciclos) = firma de fatiga de torre.
export function syntheticStressHistory(opts = {}) {
  const { id = 'T', vMean = 7.5, ti = 0.14, dmgIndex = 0, rpm = 14, blades = 3,
          harmonics = true, windowS = 1800, fs = 5, sigMean = 40 } = opts;
  const rnd = mulberry32((hash01(id) * 4294967296) >>> 0);
  const f1P = rpm / 60, f3P = f1P * blades;
  const gust = 1 + 0.8 * dmgIndex;                       // más daño → menos rigidez → más tensión
  const A3 = harmonics ? 11 * gust : 0;                  // paso de aspas (3P): el caballo de batalla
  const A1 = harmonics ? 5 * gust : 0;                   // 1P (desbalance del rotor)
  const Aturb = (harmonics ? 5.4 : 10) * gust * (vMean / 11) * (1 + ti);
  const phi = rnd() * 6.283;
  const n = Math.round(windowS * fs);
  const out = new Array(n);
  let s = 0; const rho = 0.96;                           // AR(1): turbulencia correlacionada
  for (let i = 0; i < n; i++) {
    s = rho * s + Math.sqrt(1 - rho * rho) * gauss(rnd);
    const t = i / fs;
    out[i] = sigMean + Aturb * s
           + A1 * Math.sin(2 * Math.PI * f1P * t + phi)
           + A3 * Math.sin(2 * Math.PI * f3P * t);
  }
  return out;
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;

// Evaluación de fatiga de una estructura. Devuelve daño/año, vida de diseño,
// vida consumida, RUL y DEL, más el espectro de carga (ciclos/año por bin).
export function assessFatigue(opts = {}) {
  const { detail = 80, yearsInService = 5, availability = 0.95, rpm = 14, blades = 3,
          windowS = 600, binSize = 5, harmonics = true } = opts;
  const series = syntheticStressHistory({ windowS, rpm, blades, harmonics, ...opts });
  const cycles = extractCycles(series);
  const perYear = (SECONDS_PER_YEAR / windowS) * availability;   // ventana → año

  const Dwin = minerDamage(cycles, detail);
  const Dyear = Dwin * perYear;
  const lifeYears = Dyear > 0 ? 1 / Dyear : Infinity;            // hasta D=1
  const Delapsed = Math.min(1, Dyear * yearsInService);          // fracción consumida
  const rul = isFinite(lifeYears) ? Math.max(0, lifeYears - yearsInService) : Infinity;

  // DEL a un Neq de referencia = ciclos/año del paso de aspas (3P) (o 1 Hz si no hay rotor).
  const fRef = harmonics ? (rpm / 60) * blades : 1;
  const Neq = Math.max(1, fRef * SECONDS_PER_YEAR * availability);
  const sumM = (m) => cycles.reduce((a, c) => a + c.count * Math.pow(c.range, m), 0) * perYear;
  const del3 = Math.pow(sumM(3) / Neq, 1 / 3);
  const del5 = Math.pow(sumM(5) / Neq, 1 / 5);

  // Espectro de carga: ciclos/año por bin de rango.
  const spectrum = countCycles(cycles, binSize).map(b => ({ range: b.range, perYear: b.count * perYear }));

  return {
    detail, yearsInService, availability, lifeYears, Dyear, Delapsed, rul,
    del3, del5, cyclesPerYear: cycles.reduce((a, c) => a + c.count, 0) * perYear,
    maxRange: cycles.reduce((a, c) => Math.max(a, c.range), 0),
    spectrum, limits: snLimits(detail),
  };
}

// Estado a partir de la fracción de vida consumida (semáforo).
export function fatigueState(delapsed) {
  if (delapsed >= 0.8) return { key: 'critica', label: 'Crítico' };
  if (delapsed >= 0.5) return { key: 'observacion', label: 'Observación' };
  return { key: 'operativa', label: 'Operativo' };
}
