// ──────────────────────────────────────────────────────────────────────────────
// autodesign.js — PREDIMENSIONAR (#71) y DISEÑAR por auto-selección (#72).
//
// REGLA CENTRAL (no negociable): el sistema NUNCA inventa perfiles, escuadrías ni
// secciones; sólo ELIGE entre los candidatos que se le entregan (del catálogo
// `profiles.js` o de una lista de secciones del modelo). Si ningún candidato
// cumple, lo informa claramente (best=null) y sugiere ampliar candidatos.
//
//  · predimensionar(...)  — ANTES del análisis: reglas simples de ingeniería
//    (h≈L/n, sección por carga axial aproximada…) → sección inicial editable.
//  · seleccionarPerfil(...) — DESPUÉS del análisis: prueba cada candidato con el
//    motor de verificación de G15 y elige el MEJOR por puntaje (no la primera que
//    cumpla): D/C≤1, preferir D/C en una banda objetivo (0.75–0.90), minimizar
//    peso, preferir secciones repetidas (continuidad).
// ──────────────────────────────────────────────────────────────────────────────

import { verificarElemento } from './diseno.js?v=202';
import { profileToSection, catalogNames } from './profiles.js?v=202';
import { fromShape } from './section_props.js?v=202';

// Peso por metro (kg/m) = A·ρ. ρ puede venir en t/m³ (convención del modelo, p.ej.
// acero 7.85) o en kg/m³ (7850); se normaliza a kg/m³. Sin ρ → 7850 (acero).
function weightPerM(sec, mat) {
  let rho = mat?.rho || mat?.density || 7.85;
  if (rho < 100) rho *= 1000;                 // t/m³ → kg/m³
  return (sec.A || 0) * rho;
}

/**
 * Auto-selección del mejor candidato que cumple (#72).
 * @param {object} o
 *   demands  { N, Vy, Vz, My, Mz, L }   esfuerzos de diseño (envolvente de combos)
 *   candidates  [string] nombres del catálogo  |  [{name, sec}]  secciones explícitas
 *   mat      material de diseño (con design.family/Fy/… y opc. rho)
 *   code     codeId forzado (o null → default por familia)
 *   member   { Lb, K, Cb, Cmy… } parámetros de pandeo/LTB
 *   prefs    { dcMax=1.0, dcTarget=0.85, prefer=<name> (continuidad),
 *              maxWidth, maxHeight (m): límites de dimensión transversal (#84) }
 * @returns { best, feasible:[…], all:[…] }  cada item {name, dc, ok, weight, gobierna, sec}
 */
export function seleccionarPerfil({ demands, candidates, mat, code, member, prefs = {} }) {
  const dcMax = prefs.dcMax ?? 1.0;
  const dcTarget = prefs.dcTarget ?? 0.85;
  const maxW = prefs.maxWidth, maxH = prefs.maxHeight;   // límites de dimensión (m), opc.
  const all = [];
  let dimExcluded = 0;   // candidatos descartados por exceder el límite de dimensiones (#84)
  for (const cand of candidates) {
    const name = typeof cand === 'string' ? cand : cand.name;
    const sec = (typeof cand === 'string' || !cand.sec) ? profileToSection(name) : cand.sec;
    if (!sec) continue;
    // Límite de dimensiones (#84): excluir ANTES de verificar los que no caben (p.ej.
    // sólo vigas de ancho ≤ 20 cm para un encofrado/muro de espesor fijo).
    const wh = sectionWH(sec);
    if ((maxW != null && wh.w != null && wh.w > maxW + 1e-9) ||
        (maxH != null && wh.h != null && wh.h > maxH + 1e-9)) { dimExcluded++; continue; }
    let r;
    try { r = verificarElemento({ fuerzas: demands, sec, mat, codeId: code, member }); }
    catch (e) { continue; }
    all.push({ name, dc: r.ratioMax, ok: Number.isFinite(r.ratioMax) && r.ratioMax <= dcMax,
      weight: weightPerM(sec, mat), gobierna: r.gobierna, sec });
  }
  all.sort((a, b) => a.weight - b.weight);
  const feasible = all.filter(r => r.ok);
  // Puntaje (minimizar): peso × penalización por alejarse del D/C objetivo; bonus por
  // continuidad (mismo perfil que el vecino) y por no sobre-dimensionar (D/C bajo).
  const score = r => {
    let s = r.weight * (1 + 0.6 * Math.abs(r.dc - dcTarget));
    if (prefs.prefer && r.name === prefs.prefer) s *= 0.92;   // preferir el repetido
    return s;
  };
  const ranked = feasible.slice().sort((a, b) => score(a) - score(b));
  // Nota: distinguir "ninguno por dimensiones" de "ninguno por resistencia" (#84).
  const lim = [maxW != null ? `ancho ≤ ${(maxW * 100).toFixed(0)} cm` : null,
               maxH != null ? `alto ≤ ${(maxH * 100).toFixed(0)} cm` : null].filter(Boolean).join(' · ');
  let note = '';
  if (!ranked.length) {
    if (!all.length && dimExcluded) note = `Ningún candidato respeta el límite de dimensiones (${lim}); afloje el límite o agregue candidatos más esbeltos.`;
    else { note = 'Ningún candidato cumple D/C≤1; amplíe el conjunto de candidatos o revise las cargas.';
           if (dimExcluded) note += ` (${dimExcluded} candidato(s) excluido(s) por el límite ${lim}.)`; }
  }
  return { best: ranked[0] || null, feasible: ranked, all, dimExcluded, note };
}

// Dimensiones transversales (ancho w, alto h) de una sección de diseño, en metros,
// a partir de su forma+dims; usado por el límite de dimensiones del auto-diseño (#84).
function sectionWH(sec) {
  const d = sec?.design?.dims || {};
  const shape = sec?.design?.shape;
  if (shape === 'I') return { w: d.bf, h: d.d };
  if (shape === 'pipe' || shape === 'circle') { const D = d.D ?? d.d; return { w: D, h: D }; }
  if (shape === 'box') return { w: d.b, h: d.h };
  // rect, C/L/T y resto: usar b/h de las dims o del propio sec.
  return { w: d.b ?? sec?.b, h: d.h ?? sec?.h };
}

// Conjunto de candidatos de acero del catálogo por familias.
export function steelCandidates(families = ['IPE', 'HEA', 'HEB']) {
  const out = [];
  for (const f of families) for (const n of catalogNames(f)) out.push(n);
  return out;
}

// Candidato {name, sec} de sección rectangular con props del solver desde la forma.
function rectCandidate(b, h, rebar, label) {
  const g = fromShape('rect', { b, h });
  return { name: label, sec: { A: g.A, Iz: g.Iz, Iy: g.Iy, J: g.J, b, h, Avy: g.Avz_web, Avz: g.Avy_flange,
    design: { shape: 'rect', dims: { b, h }, ...(rebar ? { rebar } : {}) } } };
}

// Candidatos de HORMIGÓN: cuadradas y rectangulares (cm) con cuantía ρ y recubr.
export function concreteCandidates({ rho = 0.012, cover_mm = 40, min = 0.20, max = 0.80, step = 0.05, rect = true } = {}) {
  const out = []; const reb = { rho, cover_mm }; const r2 = v => Math.round(v * 100);
  for (let a = min; a <= max + 1e-9; a += step) {
    a = +a.toFixed(3);
    out.push(rectCandidate(a, a, reb, `H.A. ${r2(a)}×${r2(a)}`));
    if (rect) { const h = +(a * 1.5).toFixed(3); if (h <= max + 1e-9) out.push(rectCandidate(a, h, reb, `H.A. ${r2(a)}×${r2(h)}`)); }
  }
  return out;
}

// Candidatos de MADERA: escuadrías típicas (b×h, cm).
export function timberCandidates({ bs = [0.05, 0.075, 0.10, 0.15], hs = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40] } = {}) {
  const out = []; const r2 = v => Math.round(v * 100);
  for (const b of bs) for (const h of hs) if (h >= b) out.push(rectCandidate(b, h, null, `Mad ${r2(b)}×${r2(h)}`));
  return out;
}

// Candidatos por familia de material (auto-diseño multinorma #72).
export function candidatesForFamily(family, prefs = {}) {
  if (family === 'concrete') return concreteCandidates(prefs.concrete || {});
  if (family === 'timber') return timberCandidates(prefs.timber || {});
  return steelCandidates(prefs.steelFamilies || ['IPE', 'HEA', 'HEB']);   // steel/aluminum
}

// ── Predimensionado (#71): reglas simples ANTES del análisis ────────────────────
// Devuelve { shape, dims, nota } o, para acero, { profile, nota } (nombre del catálogo).
// tipo: 'viga'|'columna' · material: 'steel'|'concrete'|'timber'
//   L  luz (m) · q carga distribuida (kN/m, vigas) · N axial (kN, columnas) ·
//   fc (MPa, H.A.) · H altura de columna (m).
export function predimensionar({ tipo = 'viga', material = 'steel', L = 5, q = 10, N = 100, fc = 25, H = 3 } = {}) {
  if (material === 'steel') {
    if (tipo === 'viga') {
      // canto ≈ L/20 (viga de acero típica). Elige el IPE de canto inmediatamente ≥.
      const dObj = L / 20;
      const ipe = catalogNames('IPE').map(profileToSectionNamed).filter(Boolean)
        .sort((a, b) => a.sec.design.dims.d - b.sec.design.dims.d);
      const pick = ipe.find(p => p.sec.design.dims.d >= dObj) || ipe[ipe.length - 1];
      return { profile: pick?.name, shape: 'I', dims: pick?.sec.design.dims, nota: `viga acero: canto objetivo ≈ L/20 = ${(dObj * 1000).toFixed(0)} mm → ${pick?.name}` };
    }
    // columna acero: HE de lado ≈ H/15 (esbeltez razonable).
    const dObj = H / 15;
    const he = catalogNames('HEB').map(profileToSectionNamed).filter(Boolean)
      .sort((a, b) => a.sec.design.dims.d - b.sec.design.dims.d);
    const pick = he.find(p => p.sec.design.dims.d >= dObj) || he[0];
    return { profile: pick?.name, shape: 'I', dims: pick?.sec.design.dims, nota: `columna acero: lado ≈ H/15 = ${(dObj * 1000).toFixed(0)} mm → ${pick?.name}` };
  }
  if (material === 'concrete') {
    if (tipo === 'viga') {
      // h≈L/11 (constructiva, redondeada a 5 cm), b≈h/2 (mín 0.20 m).
      let h = Math.ceil((L / 11) / 0.05) * 0.05; h = Math.max(h, 0.25);
      let b = Math.max(Math.ceil((h / 2) / 0.05) * 0.05, 0.20);
      return { shape: 'rect', dims: { b, h }, nota: `viga H.A.: h≈L/11=${(h * 100).toFixed(0)} cm, b≈h/2=${(b * 100).toFixed(0)} cm` };
    }
    // columna H.A.: Ag ≈ N/(0.35·f'c) (pre-diseño a compresión); cuadrada redondeada a 5 cm.
    const Ag = Math.abs(N) / (0.35 * fc * 1000);   // N en kN, fc MPa→kN/m²
    let a = Math.ceil(Math.sqrt(Ag) / 0.05) * 0.05; a = Math.max(a, 0.25);
    return { shape: 'rect', dims: { b: a, h: a }, nota: `columna H.A.: Ag≈N/(0.35·f'c) → ${(a * 100).toFixed(0)}×${(a * 100).toFixed(0)} cm` };
  }
  // madera: escuadría por flecha (h≈L/17), redondeada a 25 mm, b≈h/3.
  let h = Math.ceil((L / 17) / 0.025) * 0.025; h = Math.max(h, 0.10);
  let b = Math.max(Math.ceil((h / 3) / 0.025) * 0.025, 0.05);
  return { shape: 'rect', dims: { b, h }, nota: `madera: h≈L/17=${(h * 1000).toFixed(0)} mm, b≈h/3=${(b * 1000).toFixed(0)} mm` };
}

function profileToSectionNamed(name) { const sec = profileToSection(name); return sec ? { name, sec } : null; }
