// ──────────────────────────────────────────────────────────────────────────────
// aisc360.js — Diseño de ACERO según AISC 360-16 (LRFD y ASD).
//
//   · D2  tracción (fluencia del área bruta, φt·Fy·Ag)
//   · E3  compresión (pandeo por flexión, Fcr)
//   · F2  flexión eje fuerte de perfiles I compactos, con PANDEO LATERAL-TORSIONAL
//         (Lp, Lr, Cb); F6 eje débil; secciones cerradas/macizas → Mp
//   · G2  corte (Vn = 0.6·Fy·Aw·Cv)
//   · H1.1 interacción flexo-axial
//
// LRFD: resistencia = φ·Rn.  ASD: resistencia = Rn/Ω.  Unidades: kN, m, kN/m².
// Equivalente a la verificación de acero de SAP2000 (AISC360-16) para los modos
// cubiertos. Para perfiles tabulados, dé las dimensiones reales en sec.design.
// ──────────────────────────────────────────────────────────────────────────────

const ratObj = (D, C, extra = {}) => ({
  demanda: +(+D).toFixed(4), capacidad: +(+C).toFixed(4),
  ratio: C > 1e-12 ? +(D / C).toFixed(4) : Infinity, ...extra,
});

// factor de resistencia: LRFD → φ·Rn ; ASD → Rn/Ω
function makeFactor(method, phi, omega) {
  return method === 'ASD' ? (Rn) => Rn / omega : (Rn) => phi * Rn;
}

function checkAISC(method, { demands, mat, sec, member, options = {} }) {
  const Fy = mat.Fy, Fu = mat.Fu, E = mat.E, G = mat.G || E / 2.6;
  const L = member.L || 1, Lb = member.Lb || L, Kz = member.Kz ?? member.K ?? 1, Ky = member.Ky ?? member.K ?? 1;
  const Cb = member.Cb ?? 1.0;
  const { A, Sz, Sy, Zz, Zy, rz, ry, Iy, Cw, J, Avy, Avz, h, b, shape, lambdaFlange, lambdaWeb } = sec;

  const F = {
    N: demands.N || 0, Nsign: Math.sign(demands.N || 0) || 1,
    Vy: Math.abs(demands.Vy || 0), Vz: Math.abs(demands.Vz || 0),
    My: Math.abs(demands.My || 0), Mz: Math.abs(demands.Mz || 0),
  };
  const Nabs = Math.abs(F.N);

  // ── E3 compresión / D2 tracción ─────────────────────────────────────────────
  let axial, Pc, axMode;
  if (F.Nsign >= 0) {            // tracción → fluencia del área bruta (D2a)
    const fac = makeFactor(method, 0.90, 1.67);
    Pc = fac(Fy * A); axMode = 'tracción';
    axial = ratObj(Nabs, Pc, { modo: 'tracción', formula: method === 'ASD' ? 'Pn/Ω = Fy·Ag/1.67' : 'φPn = 0.90·Fy·Ag' });
  } else {                       // compresión (E3)
    const slz = Kz * L / rz, sly = Ky * L / ry;
    const slend = Math.max(slz, sly);
    const Fe = Math.PI ** 2 * E / (slend * slend);
    const Fcr = (Fy / Fe <= 2.25) ? Math.pow(0.658, Fy / Fe) * Fy : 0.877 * Fe;
    const fac = makeFactor(method, 0.90, 1.67);
    Pc = fac(Fcr * A); axMode = 'compresión';
    axial = ratObj(Nabs, Pc, { modo: 'compresión', esbeltez: +slend.toFixed(0),
      formula: method === 'ASD' ? 'Pn/Ω = Fcr·Ag/1.67 (E3)' : 'φPn = 0.90·Fcr·Ag (E3)' });
  }

  // ── F2/F6 flexión con LTB (eje fuerte) ──────────────────────────────────────
  const facB = makeFactor(method, 0.90, 1.67);
  const Mpz = Fy * Zz, Mpy = Math.min(Fy * Zy, 1.6 * Fy * Sy);   // F6: Mp_y ≤ 1.6 Fy Sy
  let Mnz = Mpz, ltb = 'Lb≤Lp (sin LTB)';
  if (shape === 'I' && Cw > 0 && Sz > 0) {
    const ho = member.ho || sec.ho || 0.95 * h;                 // distancia entre c.g. de alas
    const rts = Math.sqrt(Math.sqrt(Iy * Cw) / Sz);
    const c = 1;                                                            // I bisimétrico
    const Lp = 1.76 * ry * Math.sqrt(E / Fy);
    const term = (J * c) / (Sz * ho);
    const Lr = 1.95 * rts * (E / (0.7 * Fy)) * Math.sqrt(term + Math.sqrt(term * term + 6.76 * (0.7 * Fy / E) ** 2));
    if (Lb <= Lp) { Mnz = Mpz; ltb = `Lb≤Lp=${Lp.toFixed(2)}m`; }
    else if (Lb <= Lr) {
      Mnz = Math.min(Cb * (Mpz - (Mpz - 0.7 * Fy * Sz) * (Lb - Lp) / (Lr - Lp)), Mpz);
      ltb = `Lp<Lb≤Lr (Cb=${Cb})`;
    } else {
      const Fcr = (Cb * Math.PI ** 2 * E / (Lb / rts) ** 2) * Math.sqrt(1 + 0.078 * term * (Lb / rts) ** 2);
      Mnz = Math.min(Fcr * Sz, Mpz); ltb = `Lb>Lr=${Lr.toFixed(2)}m (pandeo elástico)`;
    }
  }
  const Mcz = facB(Mnz), Mcy = facB(Mpy);
  const rbz = Mcz > 1e-12 ? F.Mz / Mcz : 0, rby = Mcy > 1e-12 ? F.My / Mcy : 0;
  const flexion = rbz >= rby
    ? ratObj(F.Mz, Mcz, { eje: 'fuerte (Mz)', ltb, formula: 'Mn=Mp con LTB (F2)' })
    : ratObj(F.My, Mcy, { eje: 'débil (My)', formula: 'Mn=Mp≤1.6FySy (F6)' });

  // ── G2 corte ────────────────────────────────────────────────────────────────
  const facV = makeFactor(method, 0.90, 1.67);
  const cvLim = 2.24 * Math.sqrt(E / Fy);
  const Cv = (shape === 'I' && lambdaWeb > cvLim) ? cvLim / lambdaWeb : 1.0;   // simplificado
  const Vnz = 0.6 * Fy * Avy * Cv, Vny = 0.6 * Fy * Avz * Cv;   // Avy=alma(→Mz), Avz=alas(→My)
  const Vcz = facV(Vnz), Vcy = facV(Vny);
  const rvz = Vcz > 1e-12 ? F.Vy / Vcz : 0, rvy = Vcy > 1e-12 ? F.Vz / Vcy : 0;
  const corte = rvz >= rvy
    ? ratObj(F.Vy, Vcz, { dir: 'Vy (alma)', formula: 'Vn=0.6·Fy·Aw·Cv (G2)' })
    : ratObj(F.Vz, Vcy, { dir: 'Vz (alas)', formula: 'Vn=0.6·Fy·Af·Cv (G2)' });

  // ── H1.1 interacción flexo-axial ────────────────────────────────────────────
  const pr = Pc > 1e-12 ? Nabs / Pc : 0;
  const mm = (Mcz > 1e-12 ? F.Mz / Mcz : 0) + (Mcy > 1e-12 ? F.My / Mcy : 0);
  const H = pr >= 0.2 ? pr + (8 / 9) * mm : pr / 2 + mm;
  const interaccion = ratObj(H, 1, { adim: true, modo: axMode,
    formula: pr >= 0.2 ? 'Pr/Pc + 8/9·(Mrz/Mcz+Mry/Mcy) (H1-1a)' : 'Pr/2Pc + (Mrz/Mcz+Mry/Mcy) (H1-1b)' });

  return finalize({ material: 'acero', metodo: `AISC 360-16 (${method})`, flexion, corte, axial, interaccion }, options);
}

// Estado/gobierna a partir de los ratios.
export function finalize(r, options = {}) {
  const items = [['flexión', r.flexion], ['corte', r.corte], ['axial', r.axial], ['interacción', r.interaccion]]
    .filter(([, v]) => v);
  let iMax = 0; for (let i = 1; i < items.length; i++) if (items[i][1].ratio > items[iMax][1].ratio) iMax = i;
  r.ratioMax = items[iMax][1].ratio;
  r.gobierna = items[iMax][0];
  const aviso = options.ratio_aviso ?? 0.90, falla = options.ratio_falla ?? 1.0;
  r.estado = r.ratioMax > falla ? 'NO CUMPLE' : r.ratioMax > aviso ? 'ajustado' : 'cumple';
  return r;
}

export const aisc360_lrfd = {
  id: 'AISC360-16:LRFD', family: 'steel', label: 'AISC 360-16 (LRFD)',
  check: (input) => checkAISC('LRFD', input),
};
export const aisc360_asd = {
  id: 'AISC360-16:ASD', family: 'steel', label: 'AISC 360-16 (ASD)',
  check: (input) => checkAISC('ASD', input),
};
