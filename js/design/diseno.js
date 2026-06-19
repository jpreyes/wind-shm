// ──────────────────────────────────────────────────────────────────────────────
// Motor de DISEÑO de elementos (flexión, corte, axial) — 100% en el navegador.
//   Acero:    LRFD  (AISC 360-16 / NCh427/1)   — φRn
//   Hormigón: resistencia última (ACI 318 / NCh430), con cuantía editable
//   Madera:   tensiones admisibles modificadas (NCh1198)
// Parámetros editables en asistente/diseno_params.json. Unidades del modelo:
// kN, m. Las resistencias del JSON van en MPa (1 MPa = 1000 kN/m²).
// ──────────────────────────────────────────────────────────────────────────────

const MPA = 1000;   // 1 MPa → kN/m²

export function clasificarMaterial(nombre) {
  const n = String(nombre || '').toLowerCase();
  if (/(horm|concret|h\s*\d|fc)/.test(n)) return 'hormigon';
  if (/(mader|pino|wood|gl\b|lvl|conif)/.test(n)) return 'madera';
  if (/(acero|steel|s\s*\d{2,3}|a\s*\d{2,3}|metalcon|ipe|heb|hea|ipn)/.test(n)) return 'acero';
  return 'acero';   // por defecto, acero
}

// Geometría equivalente de la sección a partir de A, I (sección rectangular
// equivalente cuando no hay dimensiones explícitas). Devuelve módulos y radios.
function propsSeccion(sec) {
  const A  = sec.A || 1e-6;
  const Iz = sec.Iz || sec.Iy || 1e-9;     // eje fuerte (flexión Mz)
  const Iy = sec.Iy || sec.Iz || 1e-9;     // eje débil  (flexión My)
  const cz = Math.sqrt(Math.max(3 * Iz / A, 1e-12));   // fibra extrema (rect: h/2)
  const cy = Math.sqrt(Math.max(3 * Iy / A, 1e-12));
  const Sz = Iz / cz, Sy = Iy / cy;
  const rz = Math.sqrt(Iz / A), ry = Math.sqrt(Iy / A);
  const rmin = Math.min(rz, ry);
  // dimensiones rectangulares equivalentes (eje fuerte): h = 2·cz, b = A/h
  const h = 2 * cz, b = A / h;
  const dmin = 2 * Math.min(cz, cy);   // menor dimensión (para estabilidad)
  return { A, Iz, Iy, Sz, Sy, rz, ry, rmin, h, b, dmin, Avy: sec.Avy || A * 0.6, Avz: sec.Avz || A * 0.6 };
}

const ratObj = (D, C, extra = {}) => ({
  demanda: +D.toFixed(3), capacidad: +C.toFixed(3),
  ratio: C > 1e-9 ? +(D / C).toFixed(3) : Infinity, ...extra,
});

// ── ACERO — LRFD ──────────────────────────────────────────────────────────────
function disenarAcero(F, P, prm) {
  const Fy = (prm.Fy_MPa || 250) * MPA, E = (prm.E_MPa || 200000) * MPA;
  const phi = prm.phi || {}, ZS = prm.Z_sobre_S || 1.12, Cv = prm.Cv_corte ?? 1.0;
  const K = prm.K_pandeo ?? 1.0;

  // Flexión (φMn = φ·Fy·Z, Z ≈ ZS·S) — gobierna el mayor de los dos ejes
  const Mnz = (phi.flexion ?? 0.9) * Fy * (ZS * P.Sz);
  const Mny = (phi.flexion ?? 0.9) * Fy * (ZS * P.Sy);
  const rz = F.Mz / Mnz, ry = F.My / Mny;
  const flexion = ratObj(rz >= ry ? F.Mz : F.My, rz >= ry ? Mnz : Mny,
    { formula: 'φMn = φ·Fy·Z (Z≈' + ZS + '·S)', eje: rz >= ry ? 'fuerte (Mz)' : 'débil (My)' });

  // Corte (φVn = φ·0.6·Fy·Aw·Cv)
  const Vny = (phi.corte ?? 0.9) * 0.6 * Fy * P.Avy * Cv;
  const Vnz = (phi.corte ?? 0.9) * 0.6 * Fy * P.Avz * Cv;
  const cy = F.Vy / Vny, cz = F.Vz / Vnz;
  const corte = ratObj(cy >= cz ? F.Vy : F.Vz, cy >= cz ? Vny : Vnz,
    { formula: 'φVn = φ·0.6·Fy·Aw·Cv' });

  // Axial
  let axial, Pc;
  if (F.N_signo >= 0) {   // tracción → fluencia
    Pc = (phi.axial_traccion ?? 0.9) * Fy * P.A;
    axial = ratObj(F.N, Pc, { formula: 'φPn = φ·Fy·Ag', modo: 'tracción' });
  } else {                // compresión → AISC E3
    const slend = K * F.L / P.rmin;
    const Fe = Math.PI ** 2 * E / (slend * slend);
    const lim = 4.71 * Math.sqrt(E / Fy);
    const Fcr = slend <= lim ? Math.pow(0.658, Fy / Fe) * Fy : 0.877 * Fe;
    Pc = (phi.axial_compresion ?? 0.9) * Fcr * P.A;
    axial = ratObj(F.N, Pc, { formula: 'φPn = φ·Fcr·Ag (AISC E3)', modo: 'compresión', esbeltez: +slend.toFixed(0) });
  }

  // Interacción flexo-axial (AISC 360 H1.1)
  const pr = Pc > 1e-9 ? F.N / Pc : 0;
  const mm = (Mnz > 1e-9 ? F.Mz / Mnz : 0) + (Mny > 1e-9 ? F.My / Mny : 0);
  const H = pr >= 0.2 ? pr + (8 / 9) * mm : pr / 2 + mm;
  const interaccion = ratObj(H, 1, { formula: pr >= 0.2 ? 'Pr/Pc + 8/9·(Mrx/Mcx+Mry/Mcy)' : 'Pr/2Pc + (Mrx/Mcx+Mry/Mcy)', adim: true });

  return { material: 'acero', metodo: prm.metodo, flexion, corte, axial, interaccion };
}

// ── HORMIGÓN ARMADO — resistencia última (ACI 318), con cuantía editable ───────
function disenarHormigon(F, P, prm) {
  const fc = (prm.fc_MPa || 25) * MPA, fy = (prm.fy_refuerzo_MPa || 420) * MPA;
  const phi = prm.phi || {}, rho = prm.cuantia_long_rho ?? 0.01;
  const rec = (prm.recubrimiento_mm || 40) / 1000;
  const b = P.b, h = P.h, d = Math.max(h - rec, 0.5 * h);

  // Flexión: As = ρ·b·d ; a = As·fy/(0.85·fc·b) ; φMn = φ·As·fy·(d−a/2)
  const As = rho * b * d;
  const a  = As * fy / (0.85 * fc * b);
  const Mn = (phi.flexion ?? 0.9) * As * fy * (d - a / 2);
  const flexion = ratObj(Math.max(F.Mz, F.My), Mn,
    { formula: 'φMn = φ·As·fy·(d−a/2), As=ρ·b·d', rho, b: +b.toFixed(3), d: +d.toFixed(3) });

  // Corte: φVc = φ·0.17·√f'c·b·d  (ACI 22.5, MPa)
  const Vc = (phi.corte ?? 0.75) * 0.17 * Math.sqrt(prm.fc_MPa || 25) * MPA * b * d;
  const corte = ratObj(Math.max(F.Vy, F.Vz), Vc, { formula: 'φVc = φ·0.17·√f′c·b·d (sin estribos)' });

  // Axial compresión: φPn = φ·0.80·(0.85·f'c·(Ag−Ast)+fy·Ast), Ast=ρ·Ag
  let axial, Pc;
  const Ast = rho * P.A;
  if (F.N_signo < 0) {
    Pc = (phi.axial_compresion ?? 0.65) * 0.80 * (0.85 * fc * (P.A - Ast) + fy * Ast);
    axial = ratObj(F.N, Pc, { formula: 'φPn = φ·0.80·(0.85·f′c·(Ag−Ast)+fy·Ast)', modo: 'compresión' });
  } else {
    Pc = (phi.flexion ?? 0.9) * fy * Ast;   // tracción la toma la armadura
    axial = ratObj(F.N, Pc, { formula: 'φPn = φ·fy·As (tracción → armadura)', modo: 'tracción' });
  }

  // Interacción P-M lineal simplificada (conservadora; verificar con diagrama P-M)
  const H = (Pc > 1e-9 ? F.N / Pc : 0) + (Mn > 1e-9 ? Math.max(F.Mz, F.My) / Mn : 0);
  const interaccion = ratObj(H, 1, { formula: 'Pu/φPn + Mu/φMn (lineal simplificada)', adim: true });

  return { material: 'hormigon', metodo: prm.metodo, flexion, corte, axial, interaccion };
}

// ── MADERA — tensiones admisibles modificadas (NCh1198) ────────────────────────
function disenarMadera(F, P, prm) {
  const f = prm.factores_modificacion || {};
  const KMOD = (f.KD_duracion_carga ?? 1) * (f.KH_contenido_humedad ?? 1) * (f.Kt_temperatura ?? 1) * (f.otros ?? 1);
  const E = (prm.E_MPa || 10000) * MPA;
  const Fb = (prm.Fb_MPa || 10) * MPA * KMOD;
  const Fv = (prm.Fv_MPa || 1.2) * MPA * KMOD;
  const Fc = (prm.Fc_MPa || 8) * MPA * KMOD;
  const Ft = (prm.Ft_MPa || 7) * MPA * KMOD;

  // Flexión: fb = M/S ≤ F'b (gobierna el mayor eje). Tensiones en MPa para la memoria.
  const fbz = F.Mz / P.Sz, fby = F.My / P.Sy;
  const fb = Math.max(fbz, fby);
  const flexion = ratObj(fb / MPA, Fb / MPA, { formula: "f_b = M/S ≤ F'b = Fb·∏Ki", unidad: 'MPa', KMOD: +KMOD.toFixed(3) });

  // Corte: fv = 1.5·V/A ≤ F'v
  const fv = 1.5 * Math.max(F.Vy, F.Vz) / P.A;
  const corte = ratObj(fv / MPA, Fv / MPA, { formula: "f_v = 1.5·V/A ≤ F'v", unidad: 'MPa' });

  // Axial
  let axial, interaccion;
  const fa = F.N / P.A;
  if (F.N_signo >= 0) {
    axial = ratObj(fa / MPA, Ft / MPA, { formula: "f_t = N/A ≤ F't", modo: 'tracción', unidad: 'MPa' });
    // Interacción tracción + flexión: ft/F't + fb/F'b ≤ 1
    const H = fa / Ft + fb / Fb;
    interaccion = ratObj(H, 1, { formula: "f_t/F't + f_b/F'b", adim: true });
  } else {
    // Estabilidad de columna (Ylinen): FcE = 0.822·E/(le/d)² ; c=0.8
    const le = (prm.K_pandeo ?? 1) * F.L, lod = le / Math.max(P.dmin, 1e-4);
    const FcE = 0.822 * E / (lod * lod);
    const c = 0.8, alpha = FcE / Fc;
    const t = (1 + alpha) / (2 * c);
    const CP = t - Math.sqrt(Math.max(t * t - alpha / c, 0));
    const Fcc = Fc * CP;
    axial = ratObj(fa / MPA, Fcc / MPA, { formula: "f_c = N/A ≤ F'c·CP (Ylinen)", modo: 'compresión', CP: +CP.toFixed(3), unidad: 'MPa' });
    // Interacción compresión + flexión (NDS 3.9.2): (fc/F'c)² + fb/(F'b·(1−fc/FcE)) ≤ 1
    const amp = (fa < FcE) ? (1 - fa / FcE) : 1e-6;
    const H = Math.pow(fa / Fcc, 2) + fb / (Fb * amp);
    interaccion = ratObj(H, 1, { formula: "(f_c/F'c)² + f_b/[F'b·(1−f_c/F_cE)]", adim: true });
  }
  return { material: 'madera', metodo: prm.metodo, flexion, corte, axial, interaccion };
}

// ── API principal ──────────────────────────────────────────────────────────────
// fuerzas: { N (kN, signo: + tracción / − compresión), Vy, Vz, My, Mz (>0, máx |·|), L (m) }
// sec: { A, Iz, Iy, Avy, Avz } ; matNombre: string ; params: diseno_params.json
export function verificarElemento({ fuerzas, sec, matNombre, params }) {
  const tipo = clasificarMaterial(matNombre);
  const P = propsSeccion(sec);
  const F = {
    N: Math.abs(fuerzas.N || 0), N_signo: Math.sign(fuerzas.N || 0) || 1,
    Vy: Math.abs(fuerzas.Vy || 0), Vz: Math.abs(fuerzas.Vz || 0),
    My: Math.abs(fuerzas.My || 0), Mz: Math.abs(fuerzas.Mz || 0),
    L: fuerzas.L || 1,
  };
  const prm = params[tipo] || {};
  let r;
  if (tipo === 'hormigon') r = disenarHormigon(F, P, prm);
  else if (tipo === 'madera') r = disenarMadera(F, P, prm);
  else r = disenarAcero(F, P, prm);

  const ratios = [r.flexion.ratio, r.corte.ratio, r.axial.ratio, r.interaccion?.ratio ?? 0];
  const nombres = ['flexión', 'corte', 'axial', 'interacción'];
  let iMax = 0; for (let i = 1; i < ratios.length; i++) if (ratios[i] > ratios[iMax]) iMax = i;
  r.ratioMax = ratios[iMax];
  r.gobierna = nombres[iMax];
  const lim = params.limites || {};
  r.estado = r.ratioMax > (lim.ratio_falla ?? 1.0) ? 'NO CUMPLE'
    : r.ratioMax > (lim.ratio_aviso ?? 0.9) ? 'ajustado' : 'cumple';
  return r;
}
