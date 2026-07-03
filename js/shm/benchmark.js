// ─────────────────────────────────────────────────────────────────────────────
// benchmark.js — Frente 2 · R-26 · benchmarking de flota (z-score robusto).
//
// Detecta torres ANÓMALAS respecto de la flota sin necesitar un modelo previo:
// z-score robusto (mediana / MAD) de f₁ y RMS. |z|>umbral ⇒ anomalía. Robusto a
// outliers (la MAD no se infla con la propia torre anómala).
//
// Módulo ES puro → verificable en Node.  node js/shm/benchmark.js
// ─────────────────────────────────────────────────────────────────────────────

export function median(arr) {
  const s = arr.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// MAD = mediana de |x − mediana|.  σ̂ ≈ 1.4826·MAD (consistente con la normal).
export function mad(arr, med = median(arr)) {
  if (med == null) return null;
  return median(arr.filter(v => typeof v === 'number' && isFinite(v)).map(x => Math.abs(x - med)));
}

// z robusto de cada valor (null donde el valor no es numérico). Si la MAD es 0
// (flota casi idéntica) → z 0 salvo los que difieren, con una escala mínima.
export function robustZ(values) {
  const med = median(values);
  if (med == null) return values.map(() => null);
  const md = mad(values, med);
  const scale = (md && md > 1e-12) ? md * 1.4826 : (Math.max(1e-9, Math.abs(med) * 1e-6));
  return values.map(v => (typeof v === 'number' && isFinite(v)) ? (v - med) / scale : null);
}

/**
 * Anomalías de la flota.
 * @param {Array<{id, f1, rms}>} rows  últimos valores por estructura
 * @param {number} threshold  |z| que dispara anomalía (def 2.5)
 * @returns {Array<{id, metric:'f1'|'rms', z, value}>}  orden desc por |z|
 */
export function fleetAnomalies(rows, threshold = 2.5) {
  const zf = robustZ(rows.map(r => r.f1));
  const zr = robustZ(rows.map(r => r.rms));
  const out = [];
  rows.forEach((r, i) => {
    if (zf[i] != null && Math.abs(zf[i]) > threshold) out.push({ id: r.id, metric: 'f1', z: zf[i], value: r.f1 });
    if (zr[i] != null && Math.abs(zr[i]) > threshold) out.push({ id: r.id, metric: 'rms', z: zr[i], value: r.rms });
  });
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

// ── Autoverificación (node js/shm/benchmark.js) ───────────────────────────────
if (typeof process !== 'undefined' && import.meta.url.endsWith((process.argv?.[1] || '').replace(/\\/g, '/'))) {
  const ok = (c, m) => console.log((c ? '✓' : '✗') + ' ' + m);
  ok(median([1, 2, 3, 4]) === 2.5, 'median par');
  ok(median([1, 2, 3]) === 2, 'median impar');
  // flota uniforme con una torre desviada en f₁
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: 'T' + i, f1: 0.30 + (Math.random() - 0.5) * 0.002, rms: 0.02 }));
  rows[7].f1 = 0.34;   // outlier claro
  const an = fleetAnomalies(rows, 2.5);
  ok(an.length >= 1 && an[0].id === 'T7' && an[0].metric === 'f1', `detecta el outlier (T7): ${JSON.stringify(an[0])}`);
  ok(fleetAnomalies(rows.map(r => ({ ...r, f1: 0.30, rms: 0.02 }))).length === 0, 'flota idéntica → 0 anomalías');
  console.log('z de T7:', robustZ(rows.map(r => r.f1))[7].toFixed(1));
}
