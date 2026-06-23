// ──────────────────────────────────────────────────────────────────────────────
// material_props.js — Propiedades de DISEÑO de un material, GENERALIZADAS.
//
// Antes el diseño dependía de un JSON global por TIPOLOGÍA (un único Fy para todo
// el acero, un único f'c para todo el hormigón) y adivinaba el tipo por el NOMBRE.
// Ahora cada material puede llevar su propio bloque `design` con su familia y sus
// resistencias, de modo que CUALQUIER material —con las propiedades que sea— es
// diseñable. El JSON legado (diseno_params.json) queda sólo como respaldo.
//
// Las resistencias se guardan en MPa en mat.design (intuitivo para el usuario) y
// este resolver las devuelve en UNIDADES DEL MODELO (kN/m²) para que los códigos
// trabajen de forma homogénea junto a E (kN/m²) y las fuerzas (kN).
// ──────────────────────────────────────────────────────────────────────────────

const MPA = 1000;   // 1 MPa → kN/m²

// Clasificación por nombre (compatibilidad: materiales sin design.family).
export function clasificarMaterial(nombre) {
  const n = String(nombre || '').toLowerCase();
  if (/(horm|concret|h\s*\d|fc|c\d{2}\/\d{2})/.test(n)) return 'concrete';
  if (/(mader|pino|wood|gl\b|lvl|conif|timber)/.test(n)) return 'timber';
  if (/(alum)/.test(n)) return 'aluminum';
  if (/(acero|steel|s\s*\d{2,3}|a\s*\d{2,3}|metalcon|ipe|heb|hea|ipn|astm)/.test(n)) return 'steel';
  return 'steel';   // por defecto, acero
}

// Mapa de alias familia (es/en) → clave canónica.
const FAM = { acero: 'steel', steel: 'steel', hormigon: 'concrete', hormigón: 'concrete',
  concrete: 'concrete', madera: 'timber', timber: 'timber', aluminio: 'aluminum', aluminum: 'aluminum' };

// Resistencias por defecto por familia (MPa), si ni el material ni el JSON aportan.
const DEF = {
  steel:    { Fy: 250, Fu: 400 },
  concrete: { fc: 25, fyRebar: 420 },
  timber:   { Fb: 10, Fv: 1.2, Fc: 8, Ft: 7, Fcp: 2.5 },
  aluminum: { Fy: 165, Fu: 215 },
};

// Toma un valor de design (MPa) → kN/m², con cascada material → JSON legado → default.
function val(mat, legacy, keysDesign, keyLegacy, def) {
  const d = mat.design || {};
  for (const k of keysDesign) if (typeof d[k] === 'number' && d[k] > 0) return d[k] * MPA;
  if (legacy && typeof legacy[keyLegacy] === 'number' && legacy[keyLegacy] > 0) return legacy[keyLegacy] * MPA;
  return def * MPA;
}

// Resuelve la familia y TODAS las resistencias de diseño (en kN/m²) de un material.
//   mat:    material del modelo { name, E (kN/m²), G, nu, design?:{...} }
//   params: diseno_params.json (respaldo legado) — opcional.
export function resolveMaterial(mat, params = {}) {
  const d = mat.design || {};
  const family = FAM[String(d.family || '').toLowerCase()] || clasificarMaterial(mat.name);
  // claves del JSON legado por familia
  const legKey = { steel: 'acero', concrete: 'hormigon', timber: 'madera', aluminum: 'acero' }[family];
  const legacy = params[legKey] || {};
  const def = DEF[family] || DEF.steel;

  const E = mat.E > 0 ? mat.E : (legacy.E_MPa || 200000) * MPA;   // kN/m² (del material)
  const G = mat.G > 0 ? mat.G : E / (2 * (1 + (mat.nu ?? 0.3)));
  const out = { family, E, G, nu: mat.nu ?? 0.3, name: mat.name };

  if (family === 'steel' || family === 'aluminum') {
    out.Fy = val(mat, legacy, ['Fy', 'Fy_MPa'], 'Fy_MPa', def.Fy);
    out.Fu = val(mat, legacy, ['Fu', 'Fu_MPa'], 'Fu_MPa', def.Fu);
  } else if (family === 'concrete') {
    out.fc = val(mat, legacy, ['fc', 'fc_MPa'], 'fc_MPa', def.fc);
    out.fyRebar = val(mat, legacy, ['fyRebar', 'fy_refuerzo_MPa'], 'fy_refuerzo_MPa', def.fyRebar);
    out.Ec = mat.E > 0 ? mat.E : (legacy.E_MPa || 23500) * MPA;
  } else if (family === 'timber') {
    out.Fb = val(mat, legacy, ['Fb', 'Fb_MPa'], 'Fb_MPa', def.Fb);
    out.Fv = val(mat, legacy, ['Fv', 'Fv_MPa'], 'Fv_MPa', def.Fv);
    out.Fc = val(mat, legacy, ['Fc', 'Fc_MPa'], 'Fc_MPa', def.Fc);
    out.Ft = val(mat, legacy, ['Ft', 'Ft_MPa'], 'Ft_MPa', def.Ft);
    out.Fcp = val(mat, legacy, ['Fcp', 'Fcp_MPa'], 'Fcp_MPa', def.Fcp || 2.5);
    // factores de modificación (madera): producto de Ki
    const fmod = d.factores_modificacion || legacy.factores_modificacion || {};
    out.kmod = (fmod.KD_duracion_carga ?? 1) * (fmod.KH_contenido_humedad ?? 1) *
               (fmod.Kt_temperatura ?? 1) * (fmod.otros ?? 1);
  }
  return out;
}

export { MPA };
