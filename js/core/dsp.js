// ─────────────────────────────────────────────────────────────────────────────
// dsp.js — utilidades de procesamiento de señal para ReWind (extraído de
// shm_mode.js para aligerar el módulo principal). Sin dependencias ni DOM.
// ─────────────────────────────────────────────────────────────────────────────

// FFT radix-2 (Cooley-Tukey) de la mayor potencia de 2 ≤ buffer; ventana de Hann.
// `fs` = frecuencia de muestreo (Hz). Devuelve { mag: amplitud por bin, df: Hz/bin }.
export function fftMag(buf, fs = 62.5) {
  let n = 1; while (n * 2 <= buf.length) n *= 2;
  if (n < 8) return { mag: [], df: fs / Math.max(n, 1) };
  const re = buf.slice(buf.length - n);
  const mean = re.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) re[i] = (re[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  const im = new Array(n).fill(0);
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const mag = new Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]) / n;
  return { mag, df: fs / n };
}
