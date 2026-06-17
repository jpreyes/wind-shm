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

// Escuadrías comerciales de madera (pulgadas nominales → mm reales, S4S cepillado).
// Para las no tabuladas se usa nominal × 25.4 mm. Valores referenciales de docencia.
const ESCUADRIAS_MM = {
  '1x4': [19, 89], '1x6': [19, 140],
  '2x2': [38, 38], '2x3': [38, 64], '2x4': [38, 89], '2x5': [38, 114],
  '2x6': [38, 140], '2x8': [38, 184], '2x10': [38, 235], '2x12': [38, 286],
  '3x4': [64, 89], '4x4': [89, 89], '4x6': [89, 140],
};

/**
 * Escuadría de madera ("2x4", "2x8") o {b_cm,h_cm} → sección PÓRTICO.
 * Devuelve también la escuadría reconocida (mm). null si no se puede interpretar.
 */
export function escuadriaASeccion(spec, nombre) {
  if (spec && typeof spec === 'object') return { sec: rectangularASeccion(spec, nombre), etiqueta: nombre, mm: null };
  if (spec == null) return null;
  const s = String(spec).toLowerCase().replace(/["”]|pulg\w*|plg|in\b|\s/g, '');
  const key = s.replace(/[x×*]/g, 'x');
  if (ESCUADRIAS_MM[key]) {
    const [b, h] = ESCUADRIAS_MM[key];
    return { sec: rectangularASeccion({ b_mm: b, h_mm: h }, nombre || `${key}"`), etiqueta: `${key}" (${b}×${h} mm)`, mm: [b, h] };
  }
  const m = key.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (m) {
    const b = +(+m[1] * 25.4).toFixed(1), h = +(+m[2] * 25.4).toFixed(1);
    return { sec: rectangularASeccion({ b_mm: b, h_mm: h }, nombre || `${m[1]}x${m[2]}"`), etiqueta: `${m[1]}x${m[2]}" (${b}×${h} mm nominal)`, mm: [b, h] };
  }
  return null;
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
  // Despacho por tipología: entramado de madera tiene geometría propia.
  const tip = String(ficha.tipologia || 'marco').toLowerCase();
  if (/madera|tabiqu|entramad|light.?frame/.test(tip)) return generarMurosMadera(ficha, libs);

  const { reglas, perfiles, materiales } = libs;
  const rmod = reglas.reglas_modelado || {};
  const sepMax = rmod.separacion_maxima_vano_m || 6.0;
  const is2D = ficha.modo === '2D';

  const perfilPorNombre = new Map(perfiles.map((p) => [String(p.nombre).trim(), p]));
  const matPorNombre = new Map(materiales.map((m) => [String(m.nombre).trim(), m]));

  // ── Avisos: el generador NUNCA falla por datos faltantes; sustituye/estima
  //    y registra lo que hizo. tipo: 'reemplazo'|'estimado'|'omitido'|'info'.
  const avisos = [];
  const aviso = (tipo, msg) => avisos.push({ tipo, msg });

  const sec = ficha.secciones || {};
  const esRect = (s) => (s && typeof s === 'object' && (s.b_cm || s.b_mm || s.b_m)) ||
                        (typeof s === 'string' && /\d+\s*[xX×]\s*\d+/.test(s));
  // Contexto hormigón si las secciones van por dimensiones o el material lo sugiere.
  const contextoHormigon = esRect(sec.vigas) || esRect(sec.pilares) ||
                           /horm|fc|concret|^\s*h\s*\d/i.test(String(sec.material || ''));

  // Material RESILIENTE: exacto → fc/Hxx → token-match → estimar hormigón → default.
  const materialResiliente = (n) => {
    if (n != null) {
      const raw = String(n).trim();
      const exact = matPorNombre.get(raw);
      if (exact) return filaAMaterial(exact);
      const low = raw.toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, ' ');
      const fcm = low.match(/\b(\d{2,3})\b/);
      const fc = fcm ? +fcm[1] : null;
      if (fc && /(horm|h\s*\d|fc|concret)/.test(low)) {
        const byFc = materiales.find((m) => String(m.fc_MPa).trim() === String(fc) || String(m.nombre).trim().toUpperCase() === 'H' + fc);
        if (byFc) return filaAMaterial(byFc);
        const E = Math.round(4700 * Math.sqrt(fc) * 1000); // kN/m² (E=4700√fc MPa)
        aviso('estimado', `Material "${n}" no estaba en la base: se estimó hormigón fc=${fc} MPa (E≈${(E / 1e6).toFixed(0)} GPa, G≈${(Math.round(E / 2.4) / 1e6).toFixed(0)} GPa, ν=0.2, ρ=2.5 t/m³).`);
        return { name: `H${fc}(est)`, E, G: Math.round(E / 2.4), nu: 0.2, rho: 2.5 };
      }
      const qt = low.split(/\s+/).filter(Boolean);
      let best = null, bestScore = 0;
      for (const m of materiales) {
        const t = `${m.nombre} ${m.descripcion}`.toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, ' ');
        const score = qt.filter((q) => q.length >= 2 && t.includes(q)).length;
        if (score > bestScore) { best = m; bestScore = score; }
      }
      if (best && bestScore > 0) {
        if (best.nombre.toLowerCase() !== raw.toLowerCase()) aviso('info', `Material "${n}" interpretado como "${best.nombre}".`);
        return filaAMaterial(best);
      }
    }
    const defNom = contextoHormigon ? 'H30' : 'S275';
    aviso('reemplazo', `Material ${n == null ? '(no indicado)' : `"${n}"`} no reconocido: se usó ${defNom} por defecto.`);
    const def = matPorNombre.get(defNom);
    if (def) return filaAMaterial(def);
    return contextoHormigon ? { name: 'H30', E: 28700000, G: 11960000, nu: 0.2, rho: 2.5 }
                            : { name: 'S275', E: 210000000, G: 80800000, nu: 0.3, rho: 7.85 };
  };

  // Sección RESILIENTE: rectangular {b_cm,h_cm}/"20x40" → hormigón; string → perfil
  // de acero; si no se reconoce → reemplazo por defecto según contexto.
  const seccionResiliente = (spec, etiqueta) => {
    try {
      if (spec && typeof spec === 'object') return rectangularASeccion(spec, spec.nombre);
      if (typeof spec === 'string') {
        const mm = spec.match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
        if (mm) return rectangularASeccion({ b_cm: +mm[1], h_cm: +mm[2] }, spec);
        const p = perfilPorNombre.get(spec.trim());
        if (p) return perfilASeccion(p, spec.trim());
      }
    } catch { /* cae al reemplazo */ }
    if (contextoHormigon) {
      const d = etiqueta === 'pilares' ? { b_cm: 30, h_cm: 30 } : { b_cm: 25, h_cm: 50 };
      aviso('reemplazo', `Sección de ${etiqueta} ${spec == null ? '(no indicada)' : `"${typeof spec === 'object' ? JSON.stringify(spec) : spec}"`} no reconocida: se usó hormigón ${d.b_cm}×${d.h_cm} cm por defecto.`);
      return rectangularASeccion(d, `${d.b_cm}x${d.h_cm}`);
    }
    const defNom = etiqueta === 'pilares' ? 'HEB200' : 'IPE300';
    aviso('reemplazo', `Perfil de ${etiqueta} ${spec == null ? '(no indicado)' : `"${spec}"`} no encontrado: se usó ${defNom} por defecto.`);
    const dp = perfilPorNombre.get(defNom);
    if (dp) return perfilASeccion(dp, defNom);
    return rectangularASeccion({ b_cm: 30, h_cm: 30 }, '30x30');
  };

  // ── Contadores e índices ──────────────────────────────────────────────────
  const cnt = { nodes: 0, elements: 0, materials: 0, sections: 0, diaphragms: 0, loadCases: 0, combinations: 0 };
  const nodes = [], elements = [], materials = [], sections = [], diaphragms = [], loadCases = [], combinations = [];

  // ── Materiales y secciones ────────────────────────────────────────────────
  const mat = materialResiliente(sec.material);
  mat.id = ++cnt.materials; materials.push(mat);

  const secViga = seccionResiliente(sec.vigas, 'vigas');
  secViga.id = ++cnt.sections; sections.push(secViga);
  const secPilar = seccionResiliente(sec.pilares, 'pilares');
  secPilar.id = ++cnt.sections; sections.push(secPilar);

  // ── Geometría: ejes y niveles (RESILIENTE) ────────────────────────────────
  const geo = ficha.geometria || {};
  const pinf = geo.planta_inferior || {};
  // Ejes por dirección: ejes explícitos → vanos (lista o {cantidad,luz_m}) → planta.
  let ejesX = resolverEjes(pinf.Lx_m, geo.ejes_x_m, geo.vanos_x, sepMax);
  let ejesY = is2D ? [0] : resolverEjes(pinf.Ly_m, geo.ejes_y_m, geo.vanos_y, sepMax);
  if (ejesX.length < 2) { ejesX = [0, 5]; aviso('reemplazo', 'No se definió geometría en X: se usó 1 vano de 5 m por defecto.'); }
  if (!is2D && ejesY.length < 2) { ejesY = [0, 5]; aviso('reemplazo', 'No se definió geometría en Y: se usó 1 vano de 5 m por defecto.'); }
  if (!geo.niveles || !geo.niveles.length) { geo.niveles = [{ altura_m: 3 }]; aviso('reemplazo', 'No se definieron niveles: se usó 1 nivel de 3 m por defecto.'); }

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

  // vigas en cada nivel de piso (k = 1..nNiv): tramos en X y en Y.
  // Se registran todas (X e Y) con su largo y un área tributaria que se acumula
  // por paneles (regla de 45°) para repartir cargas de área en AMBAS direcciones.
  const anchoTrib2D = geo.ancho_tributario_m || sepMax; // 2D: separación entre pórticos
  const coordX = (k, i) => ejesX[i] * factorPlanta(k).sx;
  const coordY = (k, j) => ejesY[j] * factorPlanta(k).sy;
  const vigas = [];                  // {elemId, k, dir:'X'|'Y', L, trib}
  const vigaXId = new Map();         // "k,i,j" → índice (viga X de (i,j)→(i+1,j))
  const vigaYId = new Map();         // "k,i,j" → índice (viga Y de (i,j)→(i,j+1))
  for (let k = 1; k <= nNiv; k++) {
    for (let j = 0; j < ejesY.length; j++)
      for (let i = 0; i < ejesX.length - 1; i++) {
        const eid = addElem(nodeId.get(key(k, i, j)), nodeId.get(key(k, i + 1, j)), secViga.id);
        vigaXId.set(key(k, i, j), vigas.push({ elemId: eid, k, dir: 'X', L: coordX(k, i + 1) - coordX(k, i), trib: 0 }) - 1);
      }
    if (!is2D)
      for (let i = 0; i < ejesX.length; i++)
        for (let j = 0; j < ejesY.length - 1; j++) {
          const eid = addElem(nodeId.get(key(k, i, j)), nodeId.get(key(k, i, j + 1)), secViga.id);
          vigaYId.set(key(k, i, j), vigas.push({ elemId: eid, k, dir: 'Y', L: coordY(k, j + 1) - coordY(k, j), trib: 0 }) - 1);
        }
  }

  // Área tributaria por viga: 3D = regla de 45° por panel (triángulos en el lado
  // corto, trapecios en el largo) → carga vigas X e Y. 2D = ancho tributario fijo.
  if (is2D) {
    for (const v of vigas) v.trib = v.L * anchoTrib2D;
  } else {
    for (let k = 1; k <= nNiv; k++)
      for (let i = 0; i < ejesX.length - 1; i++)
        for (let j = 0; j < ejesY.length - 1; j++) {
          const sx = coordX(k, i + 1) - coordX(k, i);
          const sy = coordY(k, j + 1) - coordY(k, j);
          // área tributaria que aporta este panel a cada viga X (largo sx) y a cada viga Y (largo sy)
          const aX = sx >= sy ? sy * (2 * sx - sy) / 4 : sx * sx / 4;
          const aY = sx >= sy ? sy * sy / 4 : sx * (2 * sy - sx) / 4;
          vigas[vigaXId.get(key(k, i, j))].trib     += aX;   // borde y=j
          vigas[vigaXId.get(key(k, i, j + 1))].trib += aX;   // borde y=j+1
          vigas[vigaYId.get(key(k, i, j))].trib     += aY;   // borde x=i
          vigas[vigaYId.get(key(k, i + 1, j))].trib += aY;   // borde x=i+1
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
  // usoALo + aviso si un uso declarado no se reconoce (una vez por texto).
  const usosAvisados = new Set();
  const usoLo = (uso) => {
    if (uso == null) return null;
    const lo = usoALo(uso);
    if (lo == null && !usosAvisados.has(uso)) {
      usosAvisados.add(uso);
      aviso('omitido', `Uso "${uso}" no se encontró en NCh1537: ese nivel queda sin sobrecarga de uso (CV=0). Indíquelo en kN/m² si corresponde.`);
    }
    return lo;
  };
  const qCMk = (k) => nivel(k).muerta_adicional_kN_m2 ?? cargas.muerta_adicional_kN_m2 ?? 0;
  const qCVk = (k) => nivel(k).sobrecarga_uso_kN_m2 ?? usoLo(nivel(k).uso_NCh1537)
                    ?? cargas.sobrecarga_uso_kN_m2 ?? usoLo(cargas.uso_NCh1537) ?? 0;

  // reparte una carga de área q(k) [kN/m²] a TODAS las vigas (X e Y) según su
  // área tributaria: carga lineal equivalente w = q · A_trib / L. Conserva la
  // resultante total (Σ A_trib = área del piso) y carga ambas direcciones.
  const cargasDistFn = (qFn) => {
    const out = [];
    for (const v of vigas) {
      const q = qFn(v.k);
      if (!(q > 0) || !(v.trib > 0) || !(v.L > 0)) continue;
      const w = q * v.trib / v.L;
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

  const ub = ficha.ubicacion || {};
  if (cargas.nieve) {
    // Nieve sobre el techo (último nivel): carga de área ps (kN/m²) repartida.
    const nv = cargaNieveNCh431(ficha, reglas);
    const ps = nv.ps ?? 0;
    (nv._notas || []).forEach((n) => aviso('omitido', `Nieve: ${n}`));
    if (ps <= 0) aviso('omitido', `Nieve activada pero sin valor aplicable (¿falta latitud/altitud?): se creó el caso con carga 0.`);
    const lcNv = { id: ++cnt.loadCases, name: 'Nieve', loads: [], selfWeight: false, type: 'static', specDir: null, _nieve: nv };
    if (ps > 0) for (const v of vigas) if (v.k === nNiv && v.trib > 0 && v.L > 0) {
      lcNv.loads.push({ type: 'dist', elemId: v.elemId, dir: 'gravity', w: +(ps * v.trib / v.L).toFixed(6) });
    }
    loadCases.push(lcNv); lcNvId = lcNv.id;
  }
  if (cargas.viento) {
    // Viento en +X: presión neta de muro (zona 1 barlovento − zona 4 sotavento)
    // como carga lineal horizontal (globalX) sobre los pilares de la cara x=mín.
    if (ub.latitud_sur_deg == null && !ub.ciudad) aviso('omitido', 'Viento activado sin ubicación (latitud/ciudad): se usó la velocidad básica por defecto del cálculo.');
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
    // Espectro elástico NCh433. Saneo de parámetros (zona/suelo/categoría) con
    // defaults razonables si faltan o son inválidos, registrando el reemplazo.
    const s = reglas.cargas?.sismica_NCh433 || {};
    const sp = { ...(ficha.sismo || {}) };
    if (!(s.tabla_suelos && s.tabla_suelos[sp.suelo])) { if (sp.suelo != null) aviso('reemplazo', `Suelo sísmico "${sp.suelo}" inválido: se usó D.`); else aviso('reemplazo', 'No se indicó suelo sísmico: se usó D.'); sp.suelo = 'D'; }
    if (!(s.tabla_zona_Ao_g && s.tabla_zona_Ao_g[String(sp.zona)])) { if (sp.zona != null) aviso('reemplazo', `Zona sísmica "${sp.zona}" inválida: se usó 2.`); else aviso('reemplazo', 'No se indicó zona sísmica: se usó zona 2.'); sp.zona = 2; }
    if (!(s.tabla_categoria_I && s.tabla_categoria_I[sp.categoria])) { sp.categoria = 'II'; }
    let esp = null;
    try { esp = espectroNCh433({ ...ficha, sismo: sp }, reglas); }
    catch (e) { esp = { _error: e.message }; aviso('omitido', `No se pudo construir el espectro NCh433 (${e.message}); el caso sísmico queda sin curva.`); }
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
    _avisos: avisos,   // [{tipo:'reemplazo'|'estimado'|'omitido'|'info', msg}]
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tipología ENTRAMADO LIGERO DE MADERA (tabiques + viguetas)
//   Pies derechos (verticales) + soleras inferior/superior (horizontales) por
//   nivel; tabiques perimetrales y/o interiores con aberturas (puerta/ventana:
//   se omiten los pies derechos del vano y se coloca un dintel). Viguetas de
//   piso/techo apoyadas en los muros, cargadas por ancho tributario (1 dirección).
//   Determinista y resiliente: nunca falla por datos faltantes.
// ──────────────────────────────────────────────────────────────────────────────
export function generarMurosMadera(ficha, libs) {
  const materiales = libs.materiales || [];
  const matPorNombre = new Map(materiales.map((m) => [String(m.nombre).trim(), m]));
  const avisos = [];
  const aviso = (tipo, msg) => avisos.push({ tipo, msg });

  // ── Material (madera) ──
  const pickMat = (n) => {
    if (n != null) {
      const ex = matPorNombre.get(String(n).trim());
      if (ex) return filaAMaterial(ex);
      if (/pino|madera|wood|radiata|timber/i.test(String(n))) {
        const m2 = matPorNombre.get('Pino Radiata') ||
          materiales.find((m) => /madera|timber/i.test(`${m.tipo}`));
        if (m2) { aviso('info', `Material "${n}" interpretado como "${m2.nombre}".`); return filaAMaterial(m2); }
      }
    }
    const def = matPorNombre.get('Pino Radiata');
    aviso('reemplazo', `Material ${n == null ? '(no indicado)' : `"${n}"`}: se usó Pino Radiata por defecto (tipología madera).`);
    return def ? filaAMaterial(def) : { name: 'Pino Radiata', E: 1.0e7, G: 6.25e5, nu: 0.3, rho: 0.45 };
  };
  const mat = pickMat((ficha.secciones || {}).material); mat.id = 1;

  // ── Secciones (escuadrías) ──
  const tb = ficha.tabiques || {};
  const ep = ficha.entrepisos || {};
  const pickSec = (spec, label, defKey) => {
    const r = escuadriaASeccion(spec, label);
    if (r) { if (spec) aviso('info', `${label}: ${r.etiqueta}.`); return r.sec; }
    aviso('reemplazo', `${label}: escuadría ${spec == null ? '(no indicada)' : `"${spec}"`} no reconocida: se usó ${defKey}" por defecto.`);
    return escuadriaASeccion(defKey, label).sec;
  };
  const secStud = pickSec(tb.escuadria, 'Pie derecho/solera', '2x4'); secStud.id = 1;
  const secJoist = pickSec(ep.escuadria, 'Vigueta', '2x8'); secJoist.id = 2;

  // ── Geometría base ──
  const geo = ficha.geometria || {};
  const pinf = geo.planta_inferior || {};
  let Lx = pinf.Lx_m, Ly = pinf.Ly_m;
  if (!(Lx > 0)) { Lx = 6; aviso('reemplazo', 'No se indicó largo de planta (Lx): se usó 6 m.'); }
  if (!(Ly > 0)) { Ly = 4; aviso('reemplazo', 'No se indicó ancho de planta (Ly): se usó 4 m.'); }
  if (!geo.niveles || !geo.niveles.length) { geo.niveles = [{ altura_m: 3 }]; aviso('reemplazo', 'No se definieron niveles: 1 nivel de 3 m.'); }
  const nNiv = geo.niveles.length;
  const zNivel = [0];
  for (let k = 0; k < nNiv; k++) zNivel.push(+(zNivel[k] + (geo.niveles[k].altura_m > 0 ? geo.niveles[k].altura_m : 3)).toFixed(4));

  const sepStud = tb.separacion_m > 0 ? tb.separacion_m : 0.4;
  const sepJoist = ep.separacion_m > 0 ? ep.separacion_m : 0.6;
  const dirJ = (ep.dir === 'Y') ? 'Y' : 'X';   // dirección en que corren las viguetas
  const perim = tb.perimetro !== false;

  // ── Registro de nodos/elementos (con fusión por coordenada y deduplicado) ──
  const nodes = [], elements = [];
  let nid = 0, eid = 0;
  const nodeAt = new Map(), elemAt = new Set();
  const rk = (v) => Math.round(v * 1000) / 1000;
  const empot = () => ({ ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const rotul = () => ({ ux: 1, uy: 1, uz: 1, rx: 0, ry: 0, rz: 0 });
  const baseR = (ficha.apoyo_base === 'rotulado') ? rotul : empot;
  const getNode = (x, y, z) => {
    const k = `${rk(x)}|${rk(y)}|${rk(z)}`;
    let id = nodeAt.get(k);
    if (id == null) {
      id = ++nid; nodeAt.set(k, id);
      nodes.push({
        id, x: rk(x), y: rk(y), z: rk(z),
        restraints: rk(z) === 0 ? baseR() : { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 },
        nodeMass: { mx: 0, my: 0, mz: 0 },
        springs: { kux: 0, kuy: 0, kuz: 0, krx: 0, kry: 0, krz: 0 },
      });
    }
    return id;
  };
  const addEl = (n1, n2, secId) => {
    if (n1 == null || n2 == null || n1 === n2) return null;
    const ek = `${Math.min(n1, n2)}-${Math.max(n1, n2)}`;
    if (elemAt.has(ek)) return null;
    elemAt.add(ek);
    const id = ++eid;
    elements.push({ id, n1, n2, matId: 1, secId, releases: Array(12).fill(0) });
    return id;
  };

  // serie inclusiva [0, sep, 2·sep, …, L] con el último nodo exactamente en L
  const serie = (L, sep) => {
    const a = [0]; let x = sep;
    while (x < L - 1e-6) { a.push(+x.toFixed(4)); x += sep; }
    a.push(+L.toFixed(4));
    return a;
  };
  const merge = (a, b) => [...new Set([...a, ...b].map((v) => +(+v).toFixed(4)))].sort((p, q) => p - q);

  // Muro genérico a lo largo de un eje. axis='X' → la línea corre en X a y=fixed;
  // axis='Y' → corre en Y a x=fixed. coords = nodos de solera; studs = posiciones
  // de pie derecho; aberturas = [{a, b, alto, tipo}] (a,b = bordes del vano).
  const buildWall = (axis, fixed, coords, studs, zb, zt, aberturas = []) => {
    const P = (c, z) => axis === 'X' ? getNode(c, fixed, z) : getNode(fixed, c, z);
    // soleras inferior (zb) y superior (zt) por tramos entre nodos consecutivos
    for (let i = 0; i < coords.length - 1; i++) {
      const c0 = coords[i], c1 = coords[i + 1], mid = (c0 + c1) / 2;
      const enPuerta = aberturas.some((ab) => ab.tipo !== 'ventana' && mid > ab.a + 1e-6 && mid < ab.b - 1e-6);
      if (!enPuerta) addEl(P(c0, zb), P(c1, zb), secStud.id);  // solera inferior (sin umbral en puertas)
      addEl(P(c0, zt), P(c1, zt), secStud.id);                 // solera superior (continua)
    }
    // pies derechos (omitidos dentro de un vano)
    for (const c of studs) {
      if (aberturas.some((ab) => c > ab.a + 1e-6 && c < ab.b - 1e-6)) continue;
      addEl(P(c, zb), P(c, zt), secStud.id);
    }
    // jambas + dintel en cada abertura
    for (const ab of aberturas) {
      const zh = Math.min(zt - 1e-4, zb + ab.alto);
      addEl(P(ab.a, zb), P(ab.a, zh), secStud.id); addEl(P(ab.a, zh), P(ab.a, zt), secStud.id);
      addEl(P(ab.b, zb), P(ab.b, zh), secStud.id); addEl(P(ab.b, zh), P(ab.b, zt), secStud.id);
      addEl(P(ab.a, zh), P(ab.b, zh), secStud.id);   // dintel
    }
  };

  // Posiciones de pies derechos y de viguetas
  const Px = serie(Lx, sepStud), Py = serie(Ly, sepStud);
  const Xj = serie(Lx, sepJoist), Yj = serie(Ly, sepJoist);

  // ── Tabiques perimetrales por nivel ──
  for (let k = 1; k <= nNiv; k++) {
    const zb = zNivel[k - 1], zt = zNivel[k];
    if (!perim) break;
    // muros que corren en X (a y=0 y y=Ly): reciben viguetas si dirJ='Y' (en x=Xj)
    const cx = merge(Px, dirJ === 'Y' ? Xj : []);
    buildWall('X', 0, cx, Px, zb, zt);
    buildWall('X', Ly, cx, Px, zb, zt);
    // muros que corren en Y (a x=0 y x=Lx): reciben viguetas si dirJ='X' (en y=Yj)
    const cy = merge(Py, dirJ === 'X' ? Yj : []);
    buildWall('Y', 0, cy, Py, zb, zt);
    buildWall('Y', Lx, cy, Py, zb, zt);
  }

  // ── Tabiques interiores con aberturas ──
  for (const w of (tb.interiores || [])) {
    const k = Math.min(nNiv, Math.max(1, w.nivel || 1));
    const zb = zNivel[k - 1], zt = zNivel[k];
    const dir = w.dir === 'X' ? 'X' : 'Y';
    const Lrun = dir === 'X' ? Lx : Ly;
    const fixed = Math.min(dir === 'X' ? Ly : Lx, Math.max(0, w.pos_m != null ? w.pos_m : (dir === 'X' ? Ly : Lx) / 2));
    const ab = (w.aberturas || []).map((o) => {
      const ancho = o.ancho_m > 0 ? o.ancho_m : 0.8;
      const c = Math.min(Lrun - ancho / 2, Math.max(ancho / 2, o.centro_m != null ? o.centro_m : Lrun / 2));
      return { a: +(c - ancho / 2).toFixed(4), b: +(c + ancho / 2).toFixed(4), alto: o.alto_m > 0 ? o.alto_m : 2.0, tipo: o.tipo === 'ventana' ? 'ventana' : 'puerta' };
    });
    const edges = ab.flatMap((o) => [o.a, o.b]);
    const studs = serie(Lrun, sepStud);
    buildWall(dir, fixed, merge(studs, edges), studs, zb, zt, ab);
  }

  // ── Viguetas de piso/techo por nivel (apoyadas en muros), con ancho tributario ──
  const joists = [];   // {elemId, k, L, trib}
  for (let k = 1; k <= nNiv; k++) {
    const z = zNivel[k];
    if (dirJ === 'X') {                  // viguetas en X (de x=0 a x=Lx), distribuidas en Y
      for (let j = 0; j < Yj.length; j++) {
        const eid = addEl(getNode(0, Yj[j], z), getNode(Lx, Yj[j], z), secJoist.id);
        joists.push({ elemId: eid, k, L: Lx, trib: tributario(Yj, j) });
      }
    } else {                              // viguetas en Y (de y=0 a y=Ly), distribuidas en X
      for (let i = 0; i < Xj.length; i++) {
        const eid = addEl(getNode(Xj[i], 0, z), getNode(Xj[i], Ly, z), secJoist.id);
        joists.push({ elemId: eid, k, L: Ly, trib: tributario(Xj, i) });
      }
    }
  }

  // ── Cargas: CM (peso propio + adicional) y CV (uso) sobre viguetas ──
  const cargas = ficha.cargas || {};
  let qCMadic = cargas.muerta_adicional_kN_m2;
  if (qCMadic == null) { qCMadic = 0.3; aviso('estimado', 'Carga muerta adicional de piso no indicada: se usó 0.3 kN/m² (revestimientos + cielo).'); }
  let qCVfloor = cargas.sobrecarga_uso_kN_m2;
  if (qCVfloor == null) { qCVfloor = 2.0; aviso('estimado', 'Sobrecarga de uso no indicada: se usó 2.0 kN/m² (habitacional, NCh1537).'); }
  const qRoof = 1.0;
  if (nNiv >= 1) aviso('info', `Techo (nivel ${nNiv}) modelado como plataforma plana de viguetas con sobrecarga ${qRoof} kN/m². Las cerchas son una tipología aparte.`);
  const cvAt = (k) => (k < nNiv ? qCVfloor : qRoof);

  const lcCM = { id: 1, name: 'CM', loads: [], selfWeight: true, type: 'static', specDir: null };
  const lcCV = { id: 2, name: 'CV', loads: [], selfWeight: false, type: 'static', specDir: null };
  for (const j of joists) {
    if (j.elemId == null || !(j.L > 0) || !(j.trib > 0)) continue;
    if (qCMadic > 0) lcCM.loads.push({ type: 'dist', elemId: j.elemId, dir: 'gravity', w: +(qCMadic * j.trib).toFixed(6) });
    const cv = cvAt(j.k);
    if (cv > 0) lcCV.loads.push({ type: 'dist', elemId: j.elemId, dir: 'gravity', w: +(cv * j.trib).toFixed(6) });
  }
  const loadCases = [lcCM, lcCV];

  // ── Combinaciones (gravitacionales NCh3171) ──
  const combinations = [
    { id: 1, name: '1.4CM', factors: [{ lcId: 1, factor: 1.4 }] },
    { id: 2, name: '1.2CM+1.6CV', factors: [{ lcId: 1, factor: 1.2 }, { lcId: 2, factor: 1.6 }] },
  ];

  return {
    version: '1.0',
    units: 'kN-m',
    mode: '3D',
    nodes, elements,
    materials: [mat],
    sections: [secStud, secJoist],
    diaphragms: [],
    loadCases, combinations,
    grids: { x: Px, y: Py, z: zNivel },
    _counters: { nodes: nodes.length, elements: elements.length, materials: 1, sections: 2, diaphragms: 0, loadCases: 2, combinations: 2 },
    _generado: {
      por: 'asistente/generador.js (muros_madera)',
      reglas: (libs.reglas && libs.reglas._meta) ? libs.reglas._meta.version : undefined,
      resumen: `${nodes.length} nodos, ${elements.length} elementos (entramado de madera), ${joists.length} viguetas`,
    },
    _avisos: avisos,
  };
}
