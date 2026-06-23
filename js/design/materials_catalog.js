// ──────────────────────────────────────────────────────────────────────────────
// materials_catalog.js — BIBLIOTECA precargada de MATERIALES estándar (#69).
//
// Materiales típicos (acero, hormigón, madera, aluminio) listos para insertar en
// el modelo. Cada uno trae E/G/ν/ρ/α en UNIDADES DEL MODELO (E,G en kN/m²; ρ en
// t/m³; α en 1/°C) y su bloque `design` con familia + resistencias en MPa (lo que
// consume el motor de diseño G15). Editables tras insertarse.
//
// (La biblioteca de PERFILES de acero está en `profiles.js`, #66.)
// ──────────────────────────────────────────────────────────────────────────────

const STEEL = (Fy, Fu, E = 2.1e8) => ({ E, G: E / 2.6, nu: 0.3, rho: 7.85, alpha: 1.2e-5,
  design: { family: 'steel', Fy, Fu, E: E / 1000 } });
const CONC = (fc, E) => ({ E, G: E / 2.4, nu: 0.2, rho: 2.5, alpha: 1.0e-5,
  design: { family: 'concrete', fc, fyRebar: 420 } });
const TIMBER = (Fb, Fc, Ft, Fv, E, rho) => ({ E, G: E / 16, nu: 0.3, rho, alpha: 5e-6,
  design: { family: 'timber', Fb, Fc, Ft, Fv, Fcp: 2.5 } });

export const MATERIALS = {
  // Acero estructural (E≈210 GPa; A36/A572 a 200 GPa por convención ASTM).
  'Acero A36':         STEEL(250, 400, 2.0e8),
  'Acero A572 Gr.50':  STEEL(345, 450, 2.0e8),
  'Acero S275':        STEEL(275, 430, 2.1e8),
  'Acero S355':        STEEL(355, 490, 2.1e8),
  // Hormigón (E = 4700√f'c MPa aprox → kN/m²).
  'Hormigón H25':      CONC(25, 2.35e7),
  'Hormigón H30':      CONC(30, 2.57e7),
  'Hormigón H40':      CONC(40, 2.97e7),
  // Madera aserrada (EN 338 / valores característicos típicos).
  'Madera C16':        TIMBER(16, 17, 8.5, 1.8, 8.0e6, 0.37),
  'Madera C24':        TIMBER(24, 21, 14, 2.5, 1.1e7, 0.42),
  // Aluminio (E≈70 GPa; fo = límite 0.2 %).
  'Aluminio 6061-T6':  { E: 7.0e7, G: 2.6e7, nu: 0.33, rho: 2.7, alpha: 2.3e-5,
                         design: { family: 'aluminum', Fy: 240, Fu: 260, E: 70000 } },
};

// Familias para agrupar en la UI.
export const MATERIAL_FAMILIES = {
  Acero:    ['Acero A36', 'Acero A572 Gr.50', 'Acero S275', 'Acero S355'],
  Hormigón: ['Hormigón H25', 'Hormigón H30', 'Hormigón H40'],
  Madera:   ['Madera C16', 'Madera C24'],
  Aluminio: ['Aluminio 6061-T6'],
};

export function materialNames() { return Object.keys(MATERIALS); }

// Definición lista para `model.addMaterial(...)` (copia profunda + nombre).
export function getMaterialDef(name) {
  const m = MATERIALS[name];
  return m ? { name, ...JSON.parse(JSON.stringify(m)) } : null;
}
