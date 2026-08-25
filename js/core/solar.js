// ─────────────────────────────────────────────────────────────────────────────
// solar.js — posición solar (efemérides) para el análisis de sombras (Frente 2).
//
// Algoritmo NOAA de baja precisión (≈0.01°), suficiente para shadow-flicker y la
// visualización 3D. Devuelve elevación/azimut del sol y un vector de dirección en
// el sistema de la escena (east=+X, north=−Z, up=+Y), coherente con `toScene`.
//
// Módulo ES puro (Node + navegador). Verificable con `node` (ver test al final).
// ─────────────────────────────────────────────────────────────────────────────
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const wrap360 = (x) => ((x % 360) + 360) % 360;

/**
 * Posición del sol para una fecha UTC y un punto (lat, lon en grados, lon Este +).
 * @returns {{elevation:number, azimuth:number, declination:number}} grados.
 *   azimuth medido desde el Norte, en sentido horario (0=N, 90=E, 180=S, 270=O).
 */
export function solarPosition(date, latDeg, lonDeg) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;   // días desde J2000 (UTC)
  const L = wrap360(280.460 + 0.9856474 * n);                     // longitud media (°)
  const g = wrap360(357.528 + 0.9856003 * n) * RAD;              // anomalía media (rad)
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;  // long. eclíptica
  const eps = (23.439 - 0.0000004 * n) * RAD;                     // oblicuidad
  const delta = Math.asin(Math.sin(eps) * Math.sin(lambda));      // declinación (rad)
  const alpha = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * DEG;  // ascensión recta (°)
  const gmst = wrap360(280.46061837 + 360.98564736629 * n);       // tiempo sidéreo Greenwich (°)
  const lst = wrap360(gmst + lonDeg);                             // sidéreo local (°)
  let H = lst - alpha; H = (((H + 180) % 360) - 180) * RAD;       // ángulo horario (rad, ±180)
  const lat = latDeg * RAD;
  const elevation = Math.asin(Math.sin(lat) * Math.sin(delta) + Math.cos(lat) * Math.cos(delta) * Math.cos(H)) * DEG;
  const azimuth = wrap360(Math.atan2(-Math.sin(H), Math.tan(delta) * Math.cos(lat) - Math.sin(lat) * Math.cos(H)) * DEG);
  return { elevation, azimuth, declination: delta * DEG };
}

/** Fecha UTC a partir de hora LOCAL (tz = offset horario, p.ej. −4 para Chile). */
export function dateFromLocal(year, month0, day, hourFloat, tzOffset) {
  return new Date(Date.UTC(year, month0, day, 0, 0, 0) + (hourFloat - tzOffset) * 3600000);
}

/** Vector unitario hacia el sol en coordenadas de la escena (east=+X, north=−Z, up=+Y). */
export function sunSceneDir(elevationDeg, azimuthDeg) {
  const e = elevationDeg * RAD, a = azimuthDeg * RAD, ce = Math.cos(e);
  return { x: ce * Math.sin(a), y: Math.sin(e), z: -ce * Math.cos(a) };
}

/** Día del año (0..365) → {month0, day} para un año dado. */
export function dayOfYearToDate(doy, year) {
  const d = new Date(year, 0, 1 + doy);
  return { month0: d.getMonth(), day: d.getDate() };
}

// ── Autoverificación (node js/shm/solar.js) ───────────────────────────────────
// Mediodía solar en el hemisferio sur → el sol está al NORTE (azimut ≈ 0/360) y la
// elevación es máxima; en solsticio de junio (invierno austral) la elevación de
// mediodía ≈ 90 − |lat| − 23.44. Para Camán (lat −39.96): ≈ 26.6°.
if (typeof process !== 'undefined' && import.meta.url.endsWith((process.argv?.[1] || '').replace(/\\/g, '/'))) {
  const LAT = -39.963302, LON = -72.972458, TZ = -4;
  const noon = dateFromLocal(2026, 5, 21, 12 - LON / 15 + TZ, TZ);  // ~mediodía SOLAR (corrige longitud)
  const sp = solarPosition(noon, LAT, LON);
  const expectedElev = 90 - Math.abs(LAT) - 23.44;
  console.log('Camán, mediodía solar 21-jun:', { elev: sp.elevation.toFixed(2), az: sp.azimuth.toFixed(1), esperadaElev: expectedElev.toFixed(2) });
  const azOK = sp.azimuth < 10 || sp.azimuth > 350;                 // sol al norte
  const elevOK = Math.abs(sp.elevation - expectedElev) < 1.5;
  console.log(azOK && elevOK ? 'OK ✓ (sol al norte, elevación de invierno correcta)' : 'FALLA ✗');
}
