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
import { solarPosition } from './solar.js?v=231';

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
  if (!turb.length) return { hoursYear: 0, maxMinDay: 0, daysAffected: 0, hoursYearReal: 0, byTurbine };

  let totalMin = 0, maxDay = 0, days = 0;
  const start = Date.UTC(year, 0, 1);
  for (let d = 0; d < 365; d++) {
    let dayMin = 0;
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
      if (hit) dayMin += stepMin;
    }
    totalMin += dayMin; if (dayMin > maxDay) maxDay = dayMin; if (dayMin > 0) days++;
  }
  return { hoursYear: totalMin / 60, maxMinDay: maxDay, daysAffected: days, hoursYearReal: (totalMin / 60) * realFactor, byTurbine };
}

/** ¿Cumple el límite LAI (≤30 h/año y ≤30 min/día)? */
export function flickerOK(res, lim = FLICKER_LIMITS) {
  return res.hoursYear <= lim.hoursYear && res.maxMinDay <= lim.minDay;
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
