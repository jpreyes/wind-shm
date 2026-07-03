// ─────────────────────────────────────────────────────────────────────────────
// shadow_flicker.js — cálculo cuantitativo de parpadeo de sombra (Frente 2, Fase 4).
//
// «Worst-case» astronómico (norma alemana LAI, lo que acepta la autoridad):
//   sol SIEMPRE despejado, turbina SIEMPRE girando, aspas perpendiculares.
// Para un receptor (vivienda) cuenta los minutos del año en que la sombra del
// rotor de ALGUNA turbina lo barre, y reporta horas/año, máx min/día y días
// afectados. Compara contra el límite usual (30 h/año y 30 min/día).
//
// Geometría: la sombra del buje (altura H) cae a distancia L=H/tan(elev) en el
// azimut anti-solar; el rotor (radio R) la ensancha a la banda [(H−R)/tanθ,
// (H+R)/tanθ] y a un semiángulo atan(R/d). El receptor es «golpeado» si su
// rumbo desde la turbina coincide con el anti-solar y su distancia cae en la banda.
//
// Módulo ES puro (Node + navegador). Verificable: `node js/shm/shadow_flicker.js`.
// ─────────────────────────────────────────────────────────────────────────────
import { solarPosition } from './solar.js?v=301';

const M_PER_DEG_LAT = 111320;
export const FLICKER_LIMITS = { hoursYear: 30, minDay: 30 };   // referencia LAI (Alemania)
// Factor real-case ≈ P(sol despejado) · P(rotor operando) · P(orientación que
// proyecta sombra). Valor por defecto conservador para el sur de Chile (nuboso);
// ajustable cuando haya estadística meteo real (rosa de vientos + % de sol → R-10).
export const REAL_CASE_FACTOR = 0.15;

/**
 * Parpadeo de sombra anual «worst-case» en un receptor (+ estimación real-case).
 * @param {Array} turbines  estructuras con {lat, lon, type, built, height}
 * @param {{lat,lon}} recep  receptor (vivienda)
 * @param {object} opt  {tz=-4, stepMin=1, minElev=3, maxDist=1500, hubHeight=90, rotorR=42, year, realFactor}
 * @returns {{hoursYear, maxMinDay, daysAffected, hoursYearReal, byTurbine:Map}}
 */
export function annualFlicker(turbines, recep, opt = {}) {
  const tz = opt.tz ?? -4, stepMin = opt.stepMin ?? 1, minElev = opt.minElev ?? 3;
  const maxDist = opt.maxDist ?? 1500, H = opt.hubHeight ?? 90, R = opt.rotorR ?? 42;
  const year = opt.year ?? new Date().getFullYear();
  const realFactor = opt.realFactor ?? REAL_CASE_FACTOR;
  const mLon = M_PER_DEG_LAT * Math.cos(recep.lat * Math.PI / 180);

  // Sólo turbinas operativas (rotor montado) dentro del alcance del flicker.
  const turb = [];
  for (const t of turbines) {
    if (t.lat == null || t.lon == null) continue;
    if (t.type === 'hv' || (t.built ?? 1) < 0.97) continue;
    const tN = (recep.lat - t.lat) * M_PER_DEG_LAT, tE = (recep.lon - t.lon) * mLon;   // turbina → receptor
    const dist = Math.hypot(tN, tE);
    if (dist < 1 || dist > maxDist) continue;
    turb.push({ id: t.id, dist, bearing: (Math.atan2(tE, tN) * 180 / Math.PI + 360) % 360 });
  }
  const byTurbine = new Map();
  const cal = new Float32Array(12 * 24);   // minutos de flicker por mes × hora local (calendario de parada)
  if (!turb.length) return { hoursYear: 0, maxMinDay: 0, daysAffected: 0, hoursYearReal: 0, byTurbine, cal };

  // real-case riguroso: si llega un ponderador meteo (sol·operación·orientación)
  // se acumulan minutos ESPERADOS; si no, se cae al factor fijo (estimación).
  const realWeightFn = opt.realWeightFn || null; let realMin = 0;
  let totalMin = 0, maxDay = 0, days = 0;
  const start = Date.UTC(year, 0, 1);
  for (let d = 0; d < 365; d++) {
    let dayMin = 0;
    const month = new Date(year, 0, 1 + d).getMonth();
    for (let m = 0; m < 1440; m += stepMin) {
      const date = new Date(start + d * 86400000 + (m - tz * 60) * 60000);   // minuto local → UTC
      const sp = solarPosition(date, recep.lat, recep.lon);
      if (sp.elevation < minElev) continue;
      const anti = (sp.azimuth + 180) % 360;
      const tanE = Math.tan(sp.elevation * Math.PI / 180);
      const dLo = (H - R) / tanE, dHi = (H + R) / tanE;
      let hit = false;
      for (const t of turb) {
        if (t.dist < dLo || t.dist > dHi) continue;
        const half = Math.atan2(R, t.dist) * 180 / Math.PI;
        if (Math.abs(((anti - t.bearing + 540) % 360) - 180) <= half) {
          byTurbine.set(t.id, (byTurbine.get(t.id) || 0) + stepMin);
          hit = true;
        }
      }
      if (hit) {
        dayMin += stepMin; cal[month * 24 + ((m / 60) | 0)] += stepMin;
        if (realWeightFn) realMin += stepMin * realWeightFn(month, anti);
      }
    }
    totalMin += dayMin; if (dayMin > maxDay) maxDay = dayMin; if (dayMin > 0) days++;
  }
  const hoursYearReal = realWeightFn ? realMin / 60 : (totalMin / 60) * realFactor;
  return { hoursYear: totalMin / 60, maxMinDay: maxDay, daysAffected: days, hoursYearReal, byTurbine, cal };
}

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
/** Ventana crítica (meses y horas con flicker) a partir de la matriz mes×hora → para el calendario de parada. */
export function criticalWindow(cal) {
  let m0 = 12, m1 = -1, h0 = 24, h1 = -1, peakIdx = -1, peak = 0;
  for (let mo = 0; mo < 12; mo++) for (let h = 0; h < 24; h++) {
    const v = cal[mo * 24 + h]; if (v <= 0) continue;
    if (mo < m0) m0 = mo; if (mo > m1) m1 = mo; if (h < h0) h0 = h; if (h > h1) h1 = h;
    if (v > peak) { peak = v; peakIdx = mo * 24 + h; }
  }
  if (m1 < 0) return null;
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  return { months: `${MESES[m0]}–${MESES[m1]}`, hours: `${hh(h0)}–${hh(h1 + 1)}`,
    peak: { month: MESES[(peakIdx / 24) | 0], hour: hh(peakIdx % 24) } };
}

/**
 * Sombreado ENTRE turbinas: horas/año en que el rotor de cada turbina operativa cae
 * en la sombra de OTRAS (proxy de pérdida por sombreado mutuo). Aproximación: trata
 * el buje como un receptor a nivel de suelo.
 * @returns {{perTurbine:Array<{id,hoursYear}>, total:number}}
 */
export function interTurbineShading(turbines, opt = {}) {
  const op = turbines.filter(t => t.lat != null && t.type !== 'hv' && (t.built ?? 1) >= 0.97);
  const perTurbine = [];
  for (const t of op) {
    const others = op.filter(o => o !== t);
    const res = annualFlicker(others, { lat: t.lat, lon: t.lon }, { stepMin: opt.stepMin ?? 10, maxDist: opt.maxDist ?? 1500 });
    perTurbine.push({ id: t.id, label: t.label || t.id, hoursYear: res.hoursYear });
  }
  perTurbine.sort((a, b) => b.hoursYear - a.hoursYear);
  return { perTurbine, total: perTurbine.reduce((s, r) => s + r.hoursYear, 0) };
}

/** ¿Cumple el límite LAI (≤30 h/año y ≤30 min/día)? */
export function flickerOK(res, lim = FLICKER_LIMITS) {
  return res.hoursYear <= lim.hoursYear && res.maxMinDay <= lim.minDay;
}

/**
 * Mapa de parpadeo de sombra (worst-case) sobre un área — la salida típica del
 * software de la industria: horas/año en una grilla. Rasteriza la
 * franja de sombra de cada turbina operativa minuto a minuto del año, deduplicando
 * por celda en cada instante (una celda suma ≤1 paso por minuto, la golpee 1 o N
 * turbinas).
 * @param {Array} turbines  @param {{lat0,lat1,lon0,lon1}} bbox  @param {object} opt
 * @returns {{nx, ny, bbox, hours:Float32Array, peak:number}}
 */
export function flickerMap(turbines, bbox, opt = {}) {
  const nx = opt.nx ?? 120, ny = opt.ny ?? 80;
  const tz = opt.tz ?? -4, stepMin = opt.stepMin ?? 15, minElev = opt.minElev ?? 3;
  const maxDist = opt.maxDist ?? 1500, H = opt.hubHeight ?? 90, R = opt.rotorR ?? 42;
  const year = opt.year ?? new Date().getFullYear();
  const latC = (bbox.lat0 + bbox.lat1) / 2, lonC = (bbox.lon0 + bbox.lon1) / 2;
  const mLon = M_PER_DEG_LAT * Math.cos(latC * Math.PI / 180);
  const cw = (bbox.lon1 - bbox.lon0) * mLon / nx, ch = (bbox.lat1 - bbox.lat0) * M_PER_DEG_LAT / ny;
  const tpx = [];
  for (const t of turbines) {
    if (t.lat == null || t.type === 'hv' || (t.built ?? 1) < 0.97) continue;
    tpx.push({ x: ((t.lon - bbox.lon0) / (bbox.lon1 - bbox.lon0)) * nx, y: ((bbox.lat1 - t.lat) / (bbox.lat1 - bbox.lat0)) * ny });
  }
  const minutes = new Float32Array(nx * ny), stamp = new Int32Array(nx * ny).fill(-1);
  const inc = Math.max(cw, ch), rad = Math.max(0, Math.round(R / Math.min(cw, ch)));
  const start = Date.UTC(year, 0, 1); let gen = 0;
  for (let d = 0; d < 365; d++) {
    for (let m = 0; m < 1440; m += stepMin) {
      const sp = solarPosition(new Date(start + d * 86400000 + (m - tz * 60) * 60000), latC, lonC);
      if (sp.elevation < minElev) continue;
      const anti = (sp.azimuth + 180) * Math.PI / 180, tanE = Math.tan(sp.elevation * Math.PI / 180);
      const dLo = (H - R) / tanE, dHi = Math.min((H + R) / tanE, maxDist);
      if (dHi <= dLo) continue;
      const dirE = Math.sin(anti), dirN = Math.cos(anti);
      gen++;                                                   // un sello por instante → dedup global por celda
      for (const t0 of tpx) {
        for (let dist = dLo; dist <= dHi; dist += inc) {
          const ix = Math.round(t0.x + dirE * dist / cw), iy = Math.round(t0.y - dirN * dist / ch);
          for (let yy = Math.max(0, iy - rad); yy <= Math.min(ny - 1, iy + rad); yy++)
            for (let xx = Math.max(0, ix - rad); xx <= Math.min(nx - 1, ix + rad); xx++) {
              const idx = yy * nx + xx; if (stamp[idx] !== gen) { stamp[idx] = gen; minutes[idx] += stepMin; }
            }
        }
      }
    }
  }
  const hours = new Float32Array(nx * ny); let peak = 0;
  for (let i = 0; i < minutes.length; i++) { hours[i] = minutes[i] / 60; if (hours[i] > peak) peak = hours[i]; }
  return { nx, ny, bbox, hours, peak };
}

// ── Autoverificación (node js/shm/shadow_flicker.js) ──────────────────────────
if (typeof process !== 'undefined' && import.meta.url.endsWith((process.argv?.[1] || '').replace(/\\/g, '/'))) {
  const T = { id: 'WT', lat: -39.96, lon: -72.97, type: 'turbine', built: 1 };
  const M_LON = M_PER_DEG_LAT * Math.cos(T.lat * Math.PI / 180);
  // Receptor cercano en la franja de sombra (sol bajo de la mañana cae al WSW).
  const rad = 245 * Math.PI / 180;
  const near = { lat: T.lat + (450 * Math.cos(rad)) / M_PER_DEG_LAT, lon: T.lon + (450 * Math.sin(rad)) / M_LON };
  const far = { lat: T.lat - 5000 / M_PER_DEG_LAT, lon: T.lon };   // fuera de alcance → 0
  const n = annualFlicker([T], near, { stepMin: 1 });
  const f = annualFlicker([T], far, { stepMin: 1 });
  console.log('Receptor 450 m @245° :', n.hoursYear.toFixed(1), 'h/año ·', n.maxMinDay, 'min/día ·', n.daysAffected, 'días');
  console.log('Receptor 5 km (lejos):', f.hoursYear.toFixed(1), 'h/año');
  const ok = f.hoursYear === 0 && n.hoursYear > 5 && n.maxMinDay <= 1440;
  console.log(ok ? 'OK ✓ (cercano en la franja recibe flicker; lejos = 0)' : 'FALLA ✗');
}
