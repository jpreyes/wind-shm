// ──────────────────────────────────────────────────────────────────────────────
// Generador determinista de PÓRTICO
// ficha (validada) + reglas + bibliotecas (perfiles, materiales, sobrecargas)
//   → modelo .s3d (mismo formato que Serializer.toJSON)
//
// Es la FUENTE DE VERDAD de la ingeniería: auditable, repetible, sin LLM.
// Módulo ES puro (sin DOM ni Three.js): se usa en Node (n8n) y en la app.
// Convención de ejes: Z-up (X este, Y norte, Z vertical).
// ──────────────────────────────────────────────────────────────────────────────

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

/** Fila de materiales.csv → material PÓRTICO. */
export function filaAMaterial(m) {
  const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
  return {
    name: m.nombre,
    E: num(m.E_kN_m2), G: num(m.G_kN_m2), nu: num(m.nu), rho: num(m.rho_ton_m3),
  };
}

// ── Helpers de geometría ──────────────────────────────────────────────────────

/** Ejes de grilla: explícitos si se dan; si no, subdivide L en vanos ≤ sepMax. */
function resolverEjes(L, ejesExplicit, sepMax) {
  if (Array.isArray(ejesExplicit) && ejesExplicit.length >= 2) {
    return [...ejesExplicit].sort((a, b) => a - b);
  }
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
  const buscarMat = (n) => {
    const m = matPorNombre.get(String(n).trim());
    if (!m) throw new Error(`Material no encontrado en materiales.csv: "${n}"`);
    return m;
  };

  // ── Contadores e índices ──────────────────────────────────────────────────
  const cnt = { nodes: 0, elements: 0, materials: 0, sections: 0, diaphragms: 0, loadCases: 0, combinations: 0 };
  const nodes = [], elements = [], materials = [], sections = [], diaphragms = [], loadCases = [], combinations = [];

  // ── Materiales y secciones ────────────────────────────────────────────────
  const mat = filaAMaterial(buscarMat(ficha.secciones.material));
  mat.id = ++cnt.materials; materials.push(mat);

  const secViga = perfilASeccion(buscarPerfil(ficha.secciones.vigas), ficha.secciones.vigas);
  secViga.id = ++cnt.sections; sections.push(secViga);
  const secPilar = perfilASeccion(buscarPerfil(ficha.secciones.pilares), ficha.secciones.pilares);
  secPilar.id = ++cnt.sections; sections.push(secPilar);

  // ── Geometría: ejes y niveles ─────────────────────────────────────────────
  const geo = ficha.geometria;
  const Lx_inf = geo.planta_inferior.Lx_m;
  const Ly_inf = is2D ? 0 : geo.planta_inferior.Ly_m;
  const sup = geo.planta_superior || {};
  const Lx_sup = sup.Lx_m ?? Lx_inf;
  const Ly_sup = is2D ? 0 : (sup.Ly_m ?? Ly_inf);

  const ejesX = resolverEjes(Lx_inf, geo.ejes_x_m, sepMax);
  const ejesY = is2D ? [0] : resolverEjes(Ly_inf, geo.ejes_y_m, sepMax);

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
  for (let k = 0; k < nNiv; k++)
    for (let i = 0; i < ejesX.length; i++)
      for (let j = 0; j < ejesY.length; j++)
        addElem(nodeId.get(key(k, i, j)), nodeId.get(key(k + 1, i, j)), secPilar.id);

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

  // ── Cargas de área → líneas, casos CM / CV ────────────────────────────────
  const cargas = ficha.cargas || {};
  const anchoTrib2D = geo.ancho_tributario_m || sepMax; // 2D: separación entre pórticos

  // sobrecarga de uso (NCh1537): override explícito o lookup por descripción
  let qUso = cargas.sobrecarga_uso_kN_m2;
  if (qUso == null && cargas.uso_NCh1537 != null) {
    const buscado = String(cargas.uso_NCh1537).trim().toLowerCase();
    const fila = (libs.sobrecargas || []).find((s) => {
      const desc = String(s.descripcion).trim().toLowerCase();
      const comb = `${String(s.tipo_edificio).trim()}/${String(s.descripcion).trim()}`.toLowerCase();
      return desc === buscado || comb === buscado;
    });
    if (fila) qUso = parseFloat(fila.Lo_kNm2);
  }
  const qCM = cargas.muerta_adicional_kN_m2 || 0;
  const qCV = qUso || 0;

  // reparte una carga de área q (kN/m²) a las vigas en X por ancho tributario.
  // En 3D el ancho tributario escala con la planta variable del nivel (factor sy).
  const cargasDistDe = (q) => {
    const out = [];
    if (q <= 0) return out;
    for (const v of vigasX) {
      const w = is2D ? q * anchoTrib2D : q * tributario(ejesY, v.j) * factorPlanta(v.k).sy;
      if (w > 0) out.push({ type: 'dist', elemId: v.elemId, dir: 'gravity', w: +w.toFixed(6) });
    }
    return out;
  };

  // CM: peso propio + carga muerta de área
  const lcCM = { id: ++cnt.loadCases, name: 'CM', loads: cargasDistDe(qCM), selfWeight: true, type: 'static', specDir: null };
  loadCases.push(lcCM);
  // CV: sobrecarga de uso
  const lcCV = { id: ++cnt.loadCases, name: 'CV', loads: cargasDistDe(qCV), selfWeight: false, type: 'static', specDir: null };
  loadCases.push(lcCV);

  // casos laterales opcionales (placeholders de geometría; magnitudes se afinan aparte)
  let lcSxId = null, lcSyId = null, lcNvId = null, lcWId = null;
  if (cargas.nieve) {
    // nieve como carga de área extra sobre el techo (último nivel)
    const lcNv = { id: ++cnt.loadCases, name: 'Nieve', loads: [], selfWeight: false, type: 'static', specDir: null };
    for (const v of vigasX) if (v.k === nNiv) {
      const w = is2D ? anchoTrib2D : tributario(ejesY, v.j) * factorPlanta(v.k).sy;
      lcNv.loads.push({ type: 'dist', elemId: v.elemId, dir: 'gravity', w: +(w).toFixed(6), _nota: 'multiplicar por pf de nieve (kN/m²) validado' });
    }
    loadCases.push(lcNv); lcNvId = lcNv.id;
  }
  if (cargas.sismo) {
    loadCases.push({ id: ++cnt.loadCases, name: 'Sismo X', loads: [], selfWeight: false, type: 'spectrum', specDir: 'X' }); lcSxId = cnt.loadCases;
    if (!is2D) { loadCases.push({ id: ++cnt.loadCases, name: 'Sismo Y', loads: [], selfWeight: false, type: 'spectrum', specDir: 'Y' }); lcSyId = cnt.loadCases; }
  }
  if (cargas.viento) {
    loadCases.push({ id: ++cnt.loadCases, name: 'Viento X', loads: [], selfWeight: false, type: 'static', specDir: null }); lcWId = cnt.loadCases;
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
      const W = (qCM + fracCV * qCV) * A;           // kN (sin peso propio acero, menor)
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
