// ─────────────────────────────────────────────────────────────────────────────
// macromodel.js — MACROMODELOS (#86): subsistemas no lineales resueltos con pocos
// elementos calibrados en vez de un mallado fino. El usuario inserta un "panel" y
// el motor lo EXPANDE a su red interna de barras/cables/resortes.
//
// Primero: MURO DE RELLENO de albañilería → PUNTAL DIAGONAL EQUIVALENTE
// (Mainstone 1971 / FEMA 356 §7.5.2). El panel se reemplaza por 2 puntales diagonales
// SOLO-COMPRESIÓN (uno por diagonal): bajo carga lateral, la diagonal comprimida
// trabaja y la traccionada se afloja (N=0) — reusa `el.compressionOnly` (G14 #56).
//
// Para AGREGAR más macromodelos: registrarlos en `macro_registry.js` (ver el registro
// de `infill` al final de este archivo y la guía `docs/macromodelos.md`).
// ─────────────────────────────────────────────────────────────────────────────
import { registerMacro } from './macro_registry.js?v=208';

/**
 * Ancho del puntal diagonal equivalente (Mainstone / FEMA 356).
 *   λ₁ = [ E_m·t·sin(2θ) / (4·E_c·I_col·h_m) ]^(1/4)   (rigidez relativa marco-relleno, 1/L)
 *   a  = 0.175·(λ₁·h_col)^(−0.4)·d_m                    (ancho del puntal)
 *   A  = a·t                                            (área, material E_m)
 * @param {object} o { hm, Lm, t, Em, EcIcol, hcol }  (m, kN/m²)
 *   hm=alto del panel, Lm=largo del panel, t=espesor, Em=módulo albañilería,
 *   EcIcol=rigidez a flexión de la columna del marco, hcol=alto de la columna.
 * @returns { theta, dm, lambda, w, area }
 */
export function mainstoneStrut({ hm, Lm, t, Em, EcIcol, hcol }) {
  const theta = Math.atan2(hm, Lm);
  const dm = Math.hypot(hm, Lm);
  const lambda = Math.pow((Em * t * Math.sin(2 * theta)) / (4 * EcIcol * hm), 0.25);
  const w = 0.175 * Math.pow(lambda * hcol, -0.4) * dm;
  return { theta, dm, lambda, w, area: w * t };
}

// Ordena 4 esquinas de un panel ~rectangular por ángulo alrededor del centroide y
// devuelve los índices de las 2 DIAGONALES (pares de esquinas opuestas).
function panelDiagonals(corners) {
  const cx = corners.reduce((s, c) => s + c.x, 0) / 4;
  const cz = corners.reduce((s, c) => s + c.z, 0) / 4;
  const order = corners.map((c, i) => ({ i, a: Math.atan2(c.z - cz, c.x - cx) }))
    .sort((p, q) => p.a - q.a).map(p => p.i);
  // tras ordenar CCW, las diagonales son (0,2) y (1,3)
  return [[order[0], order[2]], [order[1], order[3]]];
}

/**
 * Inserta un muro de relleno en el modelo: crea el material de albañilería, la sección
 * del puntal (A=w·t) y 2 puntales diagonales SOLO-COMPRESIÓN biarticulados.
 * @param {Model} model
 * @param {number[]} cornerIds  4 nodos de las esquinas del panel (cualquier orden)
 * @param {object} props { Em, t, EcIcol, rho?, name?, fm? }
 * @returns { error } | { strutIds, matId, secId, strut, macroId }
 */
export function insertInfill(model, cornerIds, props = {}) {
  const corners = cornerIds.map(id => model.nodes.get(id));
  if (corners.length !== 4 || corners.some(c => !c)) return { error: 'Se requieren 4 nodos de esquina válidos.' };

  // Geometría del panel desde la caja de los 4 nodos (plano X–Z).
  const xs = corners.map(c => c.x), zs = corners.map(c => c.z);
  const Lm = Math.max(...xs) - Math.min(...xs);
  const hm = Math.max(...zs) - Math.min(...zs);
  if (Lm < 1e-6 || hm < 1e-6) return { error: 'El panel es degenerado (largo o alto nulo).' };

  const t = +props.t || 0.2;
  const Em = +props.Em || 3.0e6;              // kN/m² (≈3 GPa albañilería)
  const EcIcol = +props.EcIcol || (2.5e7 * (0.3 ** 4 / 12));   // por defecto col 30×30 H25
  const s = mainstoneStrut({ hm, Lm, t, Em, EcIcol, hcol: hm });
  if (!(s.area > 0) || !isFinite(s.area)) return { error: 'No se pudo calcular el puntal (revise propiedades).' };

  const mat = model.addMaterial({ name: props.name ? `Albañilería ${props.name}` : 'Albañilería (relleno)', E: Em, G: Em / (2 * (1 + 0.2)), nu: 0.2, rho: +props.rho || 1.8 });
  // Sección del puntal: sólo área (axial); inercia ~0 → barra biarticulada (truss).
  const sec = model.addSection({ name: `Puntal ${(s.w * 100).toFixed(0)}×${(t * 100).toFixed(0)} cm`, A: s.area, Iz: 1e-9, Iy: 1e-9, J: 1e-9, Avy: s.area, Avz: s.area });

  const macroId = (model._nextMacroId = (model._nextMacroId || 0) + 1);
  const strutIds = [];
  for (const [a, b] of panelDiagonals(corners)) {
    const el = model.addElement(corners[a].id, corners[b].id, mat.id, sec.id);
    if (!el) continue;
    el.compressionOnly = true;
    el.releases = [0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1];   // biarticulado (libera T, My, Mz en ambos extremos)
    el.macro = macroId; el.macroType = 'infill';
    strutIds.push(el.id);
  }
  if (strutIds.length < 2) return { error: 'No se pudieron crear los puntales (nodos coincidentes).' };

  // Registro del macro (para identificarlo/borrarlo como una entidad).
  if (!model.macros) model.macros = new Map();
  model.macros.set(macroId, { id: macroId, type: 'infill', corners: cornerIds.map(Number), strutIds, matId: mat.id, secId: sec.id, props: { Em, t, EcIcol }, w: s.w });

  return { strutIds, matId: mat.id, secId: sec.id, strut: s, macroId };
}

// ── Registro del macromodelo «muro de relleno» (#86) ────────────────────────────
// Patrón a seguir para los próximos macromodelos (ver docs/macromodelos.md).
registerMacro({
  id: 'infill',
  name: 'Muro de relleno — puntal diagonal',
  desc: 'Albañilería de relleno → 2 puntales diagonales solo-compresión (Mainstone/FEMA 356).',
  nodes: 4,
  nodesHint: 'las 4 esquinas del panel (marco)',
  dims: '2D',
  params: [
    { key: 'Em', label: 'E albañilería (kN/m²)', default: 3.0e6, step: 1e5, min: 1 },
    { key: 't', label: 'Espesor del muro (m)', default: 0.2, step: 0.05, min: 0.01 },
    { key: 'EcIcol', label: 'EcIcol columna del marco (kN·m²)', default: Math.round(2.5e7 * (0.3 ** 4 / 12)), step: 1000, min: 1 },
  ],
  expand: (model, nodeIds, props) => insertInfill(model, nodeIds, props),
});
