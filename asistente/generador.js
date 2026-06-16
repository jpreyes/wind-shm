// ──────────────────────────────────────────────────────────────────────────────
// Generador determinista de PÓRTICO
// ficha (validada) + reglas + bibliotecas (perfiles, materiales, sobrecargas)
//   → modelo .s3d (mismo formato que Serializer.toJSON)
//
// Es la FUENTE DE VERDAD de la ingeniería: auditable, repetible, sin LLM.
// Módulo ES puro (sin DOM ni Three.js): se usa en Node (n8n) y en la app.
// Convención de ejes: Z-up (X este, Y norte, Z vertical).
// ──────────────────────────────────────────────────────────────────────────────

import { cargaNieveNCh431, cargaVientoNCh432, espectroNCh433 } from './cargas.js';

const G_GRAV = 9.80665;          // kN por tonelada-fuerza (peso→masa)
const CM2_M2 = 1e-4;             // cm² → m²
const CM4_M4 = 1e-8;             // cm⁴ → m⁴

// ── Conversión de bibliotecas ─────────────────────────────────────────────────

/**
 * Perfil EN (cm) → sección PÓRTICO (m). OJO al mapeo de ejes:
 *  - perfiles.csv: Iy = eje FUERTE (mayor), Iz = eje DÉBIL (menor).
 *  - PÓRTICO/timoshenko.js: Φy = 12·E·Iz/(G·Avy·L²) → Iz es el eje fuerte y se
 *    empareja con Avy. Por eso se intercambian: Iz←Iy_EN, Iy←Iz_EN, Avy←Avz_EN
 *    (alma, corte mayor), Avz←Avy_EN (alas, corte menor).
 */
export function perfilASeccion(p, nombre) {
  const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
  return {
    name: nombre,
    A:   num(p.A_cm2)   * CM2_M2,
    Iz:  num(p.Iy_cm4)  * CM4_M4,   // eje fuerte
    Iy:  num(p.Iz_cm4)  * CM4_M4,   // eje débil
    J:   num(p.It_cm4)  * CM4_M4,
    Avy: num(p.Avz_cm2) * CM2_M2,   // alma  → emparejada con Iz (fuerte)
    Avz: num(p.Avy_cm2) * CM2_M2,   // alas  → emparejada con Iy (débil)
    kappay: 1.0, kappaz: 1.0,       // Av ya es el área de corte efectiva
  };
}

/**
 * Sección RECTANGULAR maciza (p.ej. viga/pilar de hormigón) definida por b×h.
 * b = ancho, h = altura (canto, eje fuerte). Acepta b_cm/h_cm o b_mm/h_mm o b_m/h_m.
 *  - Iz (fuerte) = b·h³/12 ; Iy (débil) = h·b³/12
 *  - J: constante de torsión de St. Venant para rectángulo (a≥c)
 *  - Avy = Avz = (5/6)·A  (factor de corte de Timoshenko para rectángulo)
 */
export function rectangularASeccion(spec, nombre) {
  const m = (cm, mm, mt) => cm != null ? cm / 100 : mm != null ? mm / 1000 : mt;
  const b = m(spec.b_cm, spec.b_mm, spec.b_m);
  const h = m(spec.h_cm, spec.h_mm, spec.h_m);
  if (!(b > 0) || !(h > 0)) throw new Error(`Sección rectangular inválida: ${JSON.stringify(spec)}`);
  const A = b * h;
  const Iz = b * h ** 3 / 12;   // eje fuerte (flexión en el plano del canto)
  const Iy = h * b ** 3 / 12;   // eje débil
  const a = Math.max(b, h), c = Math.min(b, h);
  const J = a * c ** 3 * (1 / 3 - 0.21 * (c / a) * (1 - c ** 4 / (12 * a ** 4)));
  const Av = (5 / 6) * A;
  const fmt = (x) => +x.toFixed(8);
  return {
    name: nombre || `${Math.round(b * 100)}x${Math.round(h * 100)}`,
    A: fmt(A), Iz: fmt(Iz), Iy: fmt(Iy), J: fmt(J),
    Avy: fmt(Av), Avz: fmt(Av), kappay: 1.0, kappaz: 1.0,
  };
}

/** Fila de materiales.csv → material PÓRTICO. */
export function filaAMaterial(m) {
  const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
  return {
    name: m.nombre,
    E: num(m.E_kN_m2), G: num(m.G_kN_m2), nu: num(m.nu), rho: num(m.rho_ton_m3),
  };
}

// ── Helpers de geometría ──────────────────────────────────────────────────────

/** Coordenadas de ejes a partir de una especificación de vanos:
 *  - lista de luces:  [3, 3, 3, 4]
 *  - uniforme:        { cantidad: 4, luz_m: 3 }
 *  Devuelve null si no hay spec válida. */
function ejesDesdeVanos(vanos) {
  let luces = null;
  if (Array.isArray(vanos) && vanos.length) luces = vanos.map(Number);
  else if (vanos && vanos.cantidad >= 1 && vanos.luz_m > 0)
    luces = Array(Math.round(vanos.cantidad)).fill(Number(vanos.luz_m));
  if (!luces || luces.some((l) => !(l > 0))) return null;
  const ejes = [0];
  for (const l of luces) ejes.push(+(ejes[ejes.length - 1] + l).toFixed(6));
  return ejes;
}

/** Ejes de grilla, por prioridad: ejes explícitos → vanos → subdividir L por sepMax. */
function resolverEjes(L, ejesExplicit, vanos, sepMax) {
  if (Array.isArray(ejesExplicit) && ejesExplicit.length >= 2) {
    return [...ejesExplicit].sort((a, b) => a - b);
  }
  const v = ejesDesdeVanos(vanos);
  if (v) return v;
  if (!(L > 0)) return [0];
  const nVanos = Math.max(1, Math.ceil(L / sepMax));
  const arr = [];
  for (let i = 0; i <= nVanos; i++) arr.push(+(L * i / nVanos).toFixed(6));
  return arr;
}

/** Ancho tributario perpendicular (Y) del eje j: media de los semivanos vecinos. */
function tributario(ejes, j) {
  const lo = j > 0 ? (ejes[j] - ejes[j - 1]) / 2 : 0;
  const hi = j < ejes.length - 1 ? (ejes[j + 1] - ejes[j]) / 2 : 0;
  return lo + hi;
}

// ── Generador principal ───────────────────────────────────────────────────────

/**
 * @param {object} ficha    conforme a ficha.schema.json (se asume ya validada)
 * @param {object} libs     { reglas, perfiles: [], materiales: [] }
 *                           perfiles/materiales = arrays de objetos (filas CSV)
 * @returns {object}        modelo .s3d (listo para JSON.stringify y abrir en PÓRTICO)
 */
export function generarModelo(ficha, libs) {
  const { reglas, perfiles, materiales } = libs;
  const rmod = reglas.reglas_modelado || {};
  const sepMax = rmod.separacion_maxima_vano_m || 6.0;
  const is2D = ficha.modo === '2D';

  const perfilPorNombre = new Map(perfiles.map((p) => [String(p.nombre).trim(), p]));
  const matPorNombre = new Map(materiales.map((m) => [String(m.nombre).trim(), m]));

  const buscarPerfil = (n) => {
    const p = perfilPorNombre.get(String(n).trim());
    if (!p) throw new Error(`Perfil no encontrado en perfiles.csv: "${n}"`);
    return p;
  };
  // Material tolerante: exacto → por fc (hormigón "fc=30"/"H30") → token-match.
  const buscarMat = (n) => {
    if (n == null) throw new Error('Falta el material (ficha.secciones.material). Para hormigón usa H20/H25/H30/H40; para acero S275/A630-420H.');
    const raw = String(n).trim();
    const exact = matPorNombre.get(raw);
    if (exact) return exact;
    const low = raw.toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, ' ');
    // fc numérico → H{fc}
    const fc = low.match(/\b(\d{2,3})\b/);
    if (fc && /(horm|h\s*\d|fc|concret)/.test(low)) {
      const byFc = materiales.find((m) => String(m.fc_MPa).trim() === fc[1] || String(m.nombre).trim().toUpperCase() === 'H' + fc[1]);
      if (byFc) return byFc;
    }
    // token-match contra nombre + descripción
    const qt = low.split(/\s+/).filter(Boolean);
    let best = null, bestScore = 0;
    for (const m of materiales) {
      const t = `${m.nombre} ${m.descripcion}`.toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, ' ');
      const score = qt.filter((q) => q.length >= 2 && t.includes(q)).length;
      if (score > bestScore) { best = m; bestScore = score; }
    }
    if (best && bestScore > 0) return best;
    throw new Error(`Material no encontrado en materiales.csv: "${n}". Use H20/H25/H30/H40 (hormigón) o S235/S275/S355/A630-420H (acero).`);
  };
  // Sección: string → perfil de acero (perfiles.csv); objeto {b_cm,h_cm} → rectangular (hormigón).
  const resolverSeccion = (spec, etiqueta) => {
    if (spec && typeof spec === 'object') return rectangularASeccion(spec, spec.nombre);
    if (typeof spec === 'string' && /^\s*\d/.test(spec)) {
      // "20x40" o "20x40cm" → rectangular
      const mm = spec.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
      if (mm) return rectangularASeccion({ b_cm: +mm[1], h_cm: +mm[2] }, spec);
    }
    if (!spec) throw new Error(`Falta la sección de ${etiqueta} (ficha.secciones.${etiqueta}).`);
    return perfilASeccion(buscarPerfil(spec), String(spec));
  };

  // ── Contadores e índices ──────────────────────────────────────────────────
  const cnt = { nodes: 0, elements: 0, materials: 0, sections: 0, diaphragms: 0, loadCases: 0, combinations: 0 };
  const nodes = [], elements = [], materials = [], sections = [], diaphragms = [], loadCases = [], combinations = [];

  // ── Materiales y secciones ────────────────────────────────────────────────
  const mat = filaAMaterial(buscarMat(ficha.secciones.material));
  mat.id = ++cnt.materials; materials.push(mat);

  const secViga = resolverSeccion(ficha.secciones.vigas, 'vigas');
  secViga.id = ++cnt.sections; sections.push(secViga);
  const secPilar = resolverSeccion(ficha.secciones.pilares, 'pilares');
  secPilar.id = ++cnt.sections; sections.push(secPilar);

  // ── Geometría: ejes y niveles ─────────────────────────────────────────────
  const geo = ficha.geometria;
  const pinf = geo.planta_inferior || {};
  // Ejes por dirección: ejes explícitos → vanos (lista o {cantidad,luz_m}) → planta.
  const ejesX = resolverEjes(pinf.Lx_m, geo.ejes_x_m, geo.vanos_x, sepMax);
  const ejesY = is2D ? [0] : resolverEjes(pinf.Ly_m, geo.ejes_y_m, geo.vanos_y, sepMax);
  if (ejesX.length < 2) throw new Error('Defina la geometría en X: vanos_x, ejes_x_m o planta_inferior.Lx_m.');
  if (!is2D && ejesY.length < 2) throw new Error('Defina la geometría en Y: vanos_y, ejes_y_m o planta_inferior.Ly_m.');

  // Luz total por los ejes resueltos (vale para planta, vanos o ejes explícitos).
  const Lx_inf = ejesX[ejesX.length - 1];
  const Ly_inf = is2D ? 0 : ejesY[ejesY.length - 1];
  const sup = geo.planta_superior || {};
  const Lx_sup = sup.Lx_m ?? Lx_inf;
  const Ly_sup = is2D ? 0 : (sup.Ly_m ?? Ly_inf);

  const nNiv = geo.niveles.length;
  const zNivel = [0];
  for (let k = 0; k < nNiv; k++) zNivel.push(zNivel[k] + geo.niveles[k].altura_m);
  // zNivel[0]=0 (base), zNivel[1..nNiv] = pisos

  // factor de planta interpolado para el piso k (1..nNiv); base usa el del piso 1
  const factorPlanta = (k) => {
    const t = nNiv > 1 ? (Math.max(1, k) - 1) / (nNiv - 1) : 0;
    return {
      sx: (Lx_inf + t * (Lx_sup - Lx_inf)) / Lx_inf,
      sy: Ly_inf > 0 ? (Ly_inf + t * (Ly_sup - Ly_inf)) / Ly_inf : 1,
    };
  };

  // ── Nodos: id por (nivel k, eje i, eje j) ─────────────────────────────────
  const empotrado = (ficha.apoyo_base || 'empotrado') === 'empotrado';
  const nodeId = new Map(); // clave "k,i,j" → id
  const key = (k, i, j) => `${k},${i},${j}`;
  for (let k = 0; k <= nNiv; k++) {
    const { sx, sy } = factorPlanta(k);
    const esBase = k === 0;
    const r = esBase
      ? (empotrado ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 }
                   : { ux: 1, uy: 1, uz: 1, rx: 0, ry: 0, rz: 0 })
      : { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 };
    for (let i = 0; i < ejesX.length; i++) {
      for (let j = 0; j < ejesY.length; j++) {
        const id = ++cnt.nodes;
        nodeId.set(key(k, i, j), id);
        nodes.push({
          id, x: +(ejesX[i] * sx).toFixed(6), y: +(ejesY[j] * sy).toFixed(6), z: zNivel[k],
          restraints: { ...r },
          nodeMass: { mx: 0, my: 0, mz: 0 },
          springs: { kux: 0, kuy: 0, kuz: 0, krx: 0, kry: 0, krz: 0 },
        });
      }
    }
  }

  // ── Elementos: pilares (verticales) y vigas (por nivel ≥ 1) ───────────────
  const addElem = (n1, n2, secId) => {
    const id = ++cnt.elements;
    elements.push({ id, n1, n2, matId: mat.id, secId, releases: Array(12).fill(0) });
    return id;
  };
  // pilares: conectan nivel k → k+1 en cada (i,j)
  const elementoPilar = new Map(); // "k,i,j" → elemId (pilar del nivel k→k+1)
  for (let k = 0; k < nNiv; k++)
    for (let i = 0; i < ejesX.length; i++)
      for (let j = 0; j < ejesY.length; j++)
        elementoPilar.set(key(k, i, j), addElem(nodeId.get(key(k, i, j)), nodeId.get(key(k + 1, i, j)), secPilar.id));

  // vigas en cada nivel de piso (k = 1..nNiv): tramos en X y en Y
  const vigasX = []; // {elemId, k, j, Lx} para reparto de cargas
  for (let k = 1; k <= nNiv; k++) {
    for (let j = 0; j < ejesY.length; j++) {
      for (let i = 0; i < ejesX.length - 1; i++) {
        const eid = addElem(nodeId.get(key(k, i, j)), nodeId.get(key(k, i + 1, j)), secViga.id);
        vigasX.push({ elemId: eid, k, j });
      }
    }
    if (!is2D) {
      for (let i = 0; i < ejesX.length; i++)
        for (let j = 0; j < ejesY.length - 1; j++)
          addElem(nodeId.get(key(k, i, j)), nodeId.get(key(k, i, j + 1)), secViga.id);
    }
  }

  // ── Diafragmas rígidos por nivel ──────────────────────────────────────────
  const usarDiaf = ficha.diafragma_rigido !== false && rmod.diafragma_rigido_por_nivel !== false;
  const areaPiso = (k) => {
    const { sx, sy } = factorPlanta(k);
    return (Lx_inf * sx) * (is2D ? 1 : (Ly_inf * sy));
  };

  // ── Cargas de área → líneas, casos CM / CV (POR NIVEL) ─────────────────────
  const cargas = ficha.cargas || {};
  const anchoTrib2D = geo.ancho_tributario_m || sepMax; // 2D: separación entre pórticos

  // Lookup sobrecarga de uso (NCh1537), tolerante: match exacto y, si no, el
  // mejor por solape de tokens (sin acentos, con prefijos). Así "bodegas
  // livianas" → "Bodegas/Áreas de mercadería liviana", "salas de clase" →
  // "Escuelas/Salas de Clases", etc.
  // normalize('NFD') separa los acentos como marcas combinantes; [^a-z0-9 ] las
  // elimina junto con la puntuación → comparación sin acentos ni símbolos.
  const norm = (s) => String(s).toLowerCase().normalize('NFD')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'o', 'en', 'con', 'area', 'areas', 'para', 'tipo', 'uso']);
  const toks = (s) => norm(s).split(' ').filter((t) => t && !STOP.has(t));
  const pref = (a, b) => (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b)) || a === b;
  const usoALo = (uso) => {
    if (uso == null) return null;
    const filas = libs.sobrecargas || [];
    const b = norm(uso);
    // 1) exacto (descripción o "tipo/descripción")
    const exacto = filas.find((s) => norm(s.descripcion) === b ||
      norm(`${s.tipo_edificio} ${s.descripcion}`) === b || norm(`${s.tipo_edificio}/${s.descripcion}`) === b);
    if (exacto) return parseFloat(exacto.Lo_kNm2);
    // 2) mejor solape de tokens
    const qt = toks(uso);
    if (!qt.length) return null;
    let best = null, bestScore = 0, bestLen = Infinity;
    for (const s of filas) {
      const rt = toks(`${s.tipo_edificio} ${s.descripcion}`);
      const score = qt.filter((q) => rt.some((r) => pref(q, r))).length;
      if (score > bestScore || (score === bestScore && score > 0 && rt.length < bestLen)) {
        best = s; bestScore = score; bestLen = rt.length;
      }
    }
    // exigir que matchee al menos la mitad de los tokens de la consulta
    return best && bestScore >= Math.ceil(qt.length / 2) ? parseFloat(best.Lo_kNm2) : null;
  };

  // Cargas POR NIVEL (k = 1..nNiv): cada nivel puede declarar su uso/cargas; si no,
  // hereda los globales de ficha.cargas. Permite ej. nivel 1 "Salas de Clases" y
  // nivel 3 "Bodegas livianas" con sobrecargas distintas.
  const nivel = (k) => geo.niveles[k - 1] || {};
  const qCMk = (k) => nivel(k).muerta_adicional_kN_m2 ?? cargas.muerta_adicional_kN_m2 ?? 0;
  const qCVk = (k) => nivel(k).sobrecarga_uso_kN_m2 ?? usoALo(nivel(k).uso_NCh1537)
                    ?? cargas.sobrecarga_uso_kN_m2 ?? usoALo(cargas.uso_NCh1537) ?? 0;

  // reparte una carga de área q(k) [kN/m²] a las vigas en X por ancho tributario;
  // en 3D el ancho tributario escala con la planta variable del nivel (factor sy).
  const cargasDistFn = (qFn) => {
    const out = [];
    for (const v of vigasX) {
      const q = qFn(v.k);
      if (!(q > 0)) continue;
      const w = is2D ? q * anchoTrib2D : q * tributario(ejesY, v.j) * factorPlanta(v.k).sy;
      if (w > 0) out.push({ type: 'dist', elemId: v.elemId, dir: 'gravity', w: +w.toFixed(6) });
    }
    return out;
  };

  // CM: peso propio + carga muerta de área (por nivel)
  const lcCM = { id: ++cnt.loadCases, name: 'CM', loads: cargasDistFn(qCMk), selfWeight: true, type: 'static', specDir: null };
  loadCases.push(lcCM);
  // CV: sobrecarga de uso (por nivel)
  const lcCV = { id: ++cnt.loadCases, name: 'CV', loads: cargasDistFn(qCVk), selfWeight: false, type: 'static', specDir: null };
  loadCases.push(lcCV);

  // casos laterales opcionales (placeholders de geometría; magnitudes se afinan aparte)
  let lcSxId = null, lcSyId = null, lcNvId = null, lcWId = null;
  const h_techo = zNivel[nNiv];

  if (cargas.nieve) {
    // Nieve sobre el techo (último nivel): carga de área ps (kN/m²) repartida.
    const nv = cargaNieveNCh431(ficha, reglas);
    const ps = nv.ps ?? 0;
    const lcNv = { id: ++cnt.loadCases, name: 'Nieve', loads: [], selfWeight: false, type: 'static', specDir: null, _nieve: nv };
    if (ps > 0) for (const v of vigasX) if (v.k === nNiv) {
      const w = ps * (is2D ? anchoTrib2D : tributario(ejesY, v.j) * factorPlanta(v.k).sy);
      lcNv.loads.push({ type: 'dist', elemId: v.elemId, dir: 'gravity', w: +w.toFixed(6) });
    }
    loadCases.push(lcNv); lcNvId = lcNv.id;
  }
  if (cargas.viento) {
    // Viento en +X: presión neta de muro (zona 1 barlovento − zona 4 sotavento)
    // como carga lineal horizontal (globalX) sobre los pilares de la cara x=mín.
    const vi = cargaVientoNCh432(ficha, reglas, h_techo);
    const pNet_kNm2 = ((vi.presiones['1'] || 0) - (vi.presiones['4'] || 0)) / 1000; // N/m²→kN/m²
    const lcW = { id: ++cnt.loadCases, name: 'Viento X', loads: [], selfWeight: false, type: 'static', specDir: null, _viento: vi, _presion_neta_muro_kNm2: +pNet_kNm2.toFixed(4) };
    if (pNet_kNm2 !== 0) for (let k = 0; k < nNiv; k++) for (let j = 0; j < ejesY.length; j++) {
      // pilar de la cara barlovento (i=0) en el nivel k→k+1
      const eid = elementoPilar.get(`${k},0,${j}`);
      const w = pNet_kNm2 * (is2D ? anchoTrib2D : tributario(ejesY, j) * factorPlanta(k + 1).sy);
      if (eid != null && w !== 0) lcW.loads.push({ type: 'dist', elemId: eid, dir: 'globalX', w: +w.toFixed(6) });
    }
    loadCases.push(lcW); lcWId = lcW.id;
  }
  if (cargas.sismo) {
    // Espectro elástico NCh433 (curva T,Sa en g). saFactor=g/R* tras el modal.
    let esp = null;
    try { esp = espectroNCh433(ficha, reglas); } catch (e) { esp = { _error: e.message }; }
    loadCases.push({ id: ++cnt.loadCases, name: 'Sismo X', loads: [], selfWeight: false, type: 'spectrum', specDir: 'X', _espectro_NCh433: esp }); lcSxId = cnt.loadCases;
    if (!is2D) { loadCases.push({ id: ++cnt.loadCases, name: 'Sismo Y', loads: [], selfWeight: false, type: 'spectrum', specDir: 'Y', _espectro_NCh433: esp }); lcSyId = cnt.loadCases; }
  }

  // ── Masa sísmica en diafragmas (CM + fracción CV) ─────────────────────────
  if (usarDiaf) {
    const fracCV = (reglas.cargas?.masa_sismica?.fraccion_CV) ?? 0.25;
    for (let k = 1; k <= nNiv; k++) {
      const A = areaPiso(k);
      const nodosNivel = [];
      let sx = 0, sy = 0;
      for (let i = 0; i < ejesX.length; i++)
        for (let j = 0; j < ejesY.length; j++) {
          const id = nodeId.get(key(k, i, j)); nodosNivel.push(id);
          const nd = nodes[id - 1]; sx += nd.x; sy += nd.y;
        }
      const cm = { x: +(sx / nodosNivel.length).toFixed(6), y: +(sy / nodosNivel.length).toFixed(6) };
      const W = (qCMk(k) + fracCV * qCVk(k)) * A;   // kN (sin peso propio acero, menor)
      const m = +(W / G_GRAV).toFixed(6);            // ton
      const { sx: fx, sy: fy } = factorPlanta(k);
      const Lx = Lx_inf * fx, Ly = is2D ? 0 : Ly_inf * fy;
      const Icm = +(m * (Lx * Lx + Ly * Ly) / 12).toFixed(6);
      diaphragms.push({ id: ++cnt.diaphragms, z: zNivel[k], nodes: nodosNivel, cm, mass: { m, Icm }, eccentricity: { ex: 0, ey: 0 } });
    }
  }

  // ── Combinaciones NCh3171 (LRFD) sobre los casos creados ──────────────────
  const addCombo = (name, pares) => {
    const factors = pares.filter(([id]) => id != null).map(([lcId, factor]) => ({ lcId, factor }));
    combinations.push({ id: ++cnt.combinations, name, factors });
  };
  addCombo('1.4CM', [[lcCM.id, 1.4]]);
  addCombo('1.2CM+1.6CV', [[lcCM.id, 1.2], [lcCV.id, 1.6]]);
  if (lcNvId) addCombo('1.2CM+1.6N+1.0CV', [[lcCM.id, 1.2], [lcNvId, 1.6], [lcCV.id, 1.0]]);
  if (lcWId)  { addCombo('1.2CM+1.0W+1.0CV', [[lcCM.id, 1.2], [lcWId, 1.0], [lcCV.id, 1.0]]);
                addCombo('0.9CM+1.0W', [[lcCM.id, 0.9], [lcWId, 1.0]]); }
  if (lcSxId) { addCombo('1.2CM+1.0Ex+1.0CV', [[lcCM.id, 1.2], [lcSxId, 1.0], [lcCV.id, 1.0]]);
                addCombo('0.9CM+1.0Ex', [[lcCM.id, 0.9], [lcSxId, 1.0]]); }
  if (lcSyId) { addCombo('1.2CM+1.0Ey+1.0CV', [[lcCM.id, 1.2], [lcSyId, 1.0], [lcCV.id, 1.0]]);
                addCombo('0.9CM+1.0Ey', [[lcCM.id, 0.9], [lcSyId, 1.0]]); }

  // ── Ensamblar modelo .s3d ─────────────────────────────────────────────────
  return {
    version: '1.0',
    units: 'kN-m',
    mode: is2D ? '2D' : '3D',
    nodes, elements, materials, sections, diaphragms, loadCases, combinations,
    grids: { x: ejesX, y: ejesY, z: zNivel },
    _counters: { ...cnt },
    _generado: {
      por: 'asistente/generador.js',
      reglas: reglas._meta?.version,
      resumen: `${nodes.length} nodos, ${elements.length} elementos, ${loadCases.length} casos, ${combinations.length} combinaciones`,
    },
  };
}
