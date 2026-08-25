// ─────────────────────────────────────────────────────────────────────────────
// meteo_caman.js — datos meteorológicos del sitio para el real-case de sombra
// (primer trozo de R-10: una «fuente de datos» meteo que consume shadow_flicker).
//
// El worst-case (LAI) asume sol siempre despejado y rotor siempre girando. El
// REAL-CASE pondera cada instante por la probabilidad real de:
//   1. cielo despejado (estadística de horas de sol por mes),
//   2. rotor operando (viento entre cut-in y cut-out),
//   3. orientación del rotor (cara hacia la línea sol→receptor) según la rosa de
//      vientos — el rotor encara el viento, así que su sombra es máxima cuando el
//      viento sopla a lo largo de esa línea y nula cuando es perpendicular.
//
// ⚠️ VALORES ESTIMADOS para Valdivia / Los Ríos (clima muy nuboso, vientos del
// N–NW en invierno y SW en verano). Reemplazar por un TMY / estación meteo del
// parque cuando esté disponible (ese es el camino industrial de R-10).
// ─────────────────────────────────────────────────────────────────────────────

// Fracción de las horas de DÍA con sol despejado, por mes (ene…dic). Valdivia:
// ~1600 h de sol/año sobre ~4400 h de día → media ~0.36, mínimo en invierno.
const sunshineByMonth = [0.50, 0.47, 0.40, 0.30, 0.22, 0.16, 0.18, 0.24, 0.31, 0.38, 0.44, 0.49];

// Rosa de vientos: frecuencia por sector (16), N, NNE, NE, …, NNO. Suma ≈ 1.
// Predominio N–NO (frentes de invierno) y un lóbulo S–SO.
const windRose = [
  0.10, 0.05, 0.04, 0.03, 0.03, 0.03, 0.04, 0.05,   // N..SSE
  0.08, 0.09, 0.10, 0.07, 0.06, 0.05, 0.05, 0.08,   // S..NNO
];

export const METEO_CAMAN = {
  sunshineByMonth,
  windRose,
  sectors: 16,
  operating: 0.82,                 // fracción de tiempo con el rotor girando (cut-in..cut-out)
  source: 'Estimación sitio (refinar con TMY/estación) — R-10',
};

// Factor de orientación: cara del rotor (normal = dirección del viento) proyectada
// sobre la línea sol→receptor (azimut anti-solar). 0 = rotor de canto (sin sombra),
// 1 = rotor de frente. Promedia |cos(θ)| ponderado por la rosa de vientos.
export function orientationFactor(antiAzimuthDeg, meteo = METEO_CAMAN) {
  const n = meteo.sectors, rose = meteo.windRose;
  let f = 0, sum = 0;
  for (let s = 0; s < n; s++) {
    const dir = s * 360 / n;                                   // dirección del sector (°)
    f += rose[s] * Math.abs(Math.cos((dir - antiAzimuthDeg) * Math.PI / 180));
    sum += rose[s];
  }
  return sum > 0 ? f / sum : 0;
}

// Peso real-case de un instante (mes 0–11, azimut anti-solar). ∈ [0,1].
export function realCaseWeight(month, antiAzimuthDeg, meteo = METEO_CAMAN) {
  return (meteo.sunshineByMonth[month] ?? 0.3) * meteo.operating * orientationFactor(antiAzimuthDeg, meteo);
}
