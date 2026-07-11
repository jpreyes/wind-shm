// ─────────────────────────────────────────────────────────────────────────────
// turbine.js — MACROMODELO «Torre eólica» (wind-shm)
//
// Gemelo digital estructural de una aerogenerador onshore, resuelto con pocos
// elementos calibrados (contrato de #86, ver docs/macromodelos.md):
//
//   • FUSTE cónico de acero  → viga-columna de Timoshenko SEGMENTADA (tubular
//     hueca, D y espesor variables por tramo). Lineal; el P-Δ lo aporta el solver.
//   • RNA (rotor + góndola)  → MASA CONCENTRADA traslacional en un nodo EXCÉNTRICO
//     unido al tope con un LINK RÍGIDO («truco del brazo rígido»): la masa sobre el
//     brazo emula la excentricidad y la inercia rotacional de la RNA sin tocar el
//     solver (usa node.nodeMass + model.addLink).
//   • FUNDACIÓN → dos opciones (param `baseType`):
//        0 = RESORTES lineales en la base (lateral kL, rocking kR, vertical kV,
//            torsional kT) vía node.springs  [por defecto].
//        1 = ELEMENTO CORTO ENTERRADO (empotramiento aparente): pila equivalente
//            de largo Lf, empotrada en su base, que da flexibilidad lateral+rocking
//            en la cota de fundación.
//
// Valores por defecto ≈ torre onshore de ~3 MW (parametrizables). El usuario sólo
// selecciona el NODO BASE; el expand construye toda la torre hacia arriba.
// ─────────────────────────────────────────────────────────────────────────────
import { registerMacro } from '../macro_registry.js?v=320';

/**
 * Propiedades de una sección tubular circular hueca (acero del fuste).
 * @param {number} D  diámetro exterior (m)
 * @param {number} t  espesor de pared (m)
 * @returns { A, I, J, Av }  (m², m⁴, m⁴, m²)
 */
export function tubeSection(D, t) {
  const Din = Math.max(D - 2 * t, 1e-6);
  const A = (Math.PI / 4) * (D * D - Din * Din);
  const I = (Math.PI / 64) * (D ** 4 - Din ** 4);   // Iy = Iz por simetría
  const J = 2 * I;                                   // tubo circular: J = Iy + Iz
  const Av = 0.5 * A;                                // tubo de pared delgada: κ ≈ 0.5
  return { A, I, J, Av };
}

/**
 * Construye el gemelo digital de una torre eólica a partir del nodo base.
 * @param {Model} model
 * @param {number[]} nodeIds  [idNodoBase]
 * @param {object} p  parámetros (ver `params` del registro)
 * @returns { error } | { macroId, towerNodes, topNode, midNode, rnaNode, baseNode, elemIds }
 */
export function insertTurbine(model, nodeIds, p = {}) {
  const base = model.nodes.get(nodeIds?.[0]);
  if (!base) return { error: 'Seleccione el nodo base de la torre.' };

  // ── Parámetros (con defaults de torre ~3 MW) ──────────────────────────────
  const H     = +p.H     || 90;       // altura de buje (m)
  const Dbase = +p.Dbase || 4.3;      // diámetro en la base (m)
  const Dtop  = +p.Dtop  || 2.9;      // diámetro en el tope (m)
  const tbase = +p.tbase || 0.030;    // espesor en la base (m)
  const ttop  = +p.ttop  || 0.015;    // espesor en el tope (m)
  const nseg  = Math.max(2, Math.round(+p.nseg || 10));
  const mRNA  = +p.mRNA  || 130;      // masa rotor+góndola (ton)
  const eRNA  = Number.isFinite(+p.eRNA) ? +p.eRNA : 2.0;   // excentricidad CG RNA (m, +X); 0 válido
  const E     = +p.E     || 2.1e8;    // acero (kN/m²) ≈ 210 GPa
  const nu    = +p.nu    || 0.3;
  const rho   = +p.rho   || 7.85;     // densidad acero (ton/m³)
  const kL    = +p.kL    || 5.0e6;    // resorte lateral (kN/m)
  const kR    = +p.kR    || 1.0e9;    // resorte rocking (kN·m/rad)
  const kV    = +p.kV    || 5.0e6;    // resorte vertical (kN/m)
  const kT    = +p.kT    || 1.0e9;    // resorte torsional (kN·m/rad)
  const baseType = Math.round(+p.baseType || 0);   // 0=resortes, 1=enterrado
  const Lf    = +p.Lf    || 10;       // largo enterrado (m), si baseType=1

  if (!(H > 0) || !(Dbase > 0) || !(Dtop > 0)) return { error: 'Geometría inválida (H, D > 0).' };

  const G = E / (2 * (1 + nu));
  const x0 = base.x, y0 = base.y, z0 = base.z;

  const macroId = (model._nextMacroId = (model._nextMacroId || 0) + 1);
  const mat = model.addMaterial({ name: `Acero torre ${macroId}`, E, G, nu, rho });

  // ── Fuste: nodos del eje (base → tope) ────────────────────────────────────
  const towerNodes = [base.id];
  for (let i = 1; i <= nseg; i++) {
    const z = z0 + (H * i) / nseg;
    towerNodes.push(model.addNode(x0, y0, z).id);
  }
  const topNode = towerNodes[towerNodes.length - 1];

  // ── Fuste: una sección + un elemento por tramo (cónico) ───────────────────
  const elemIds = [], secIds = [];
  const lerp = (a, b, s) => a + (b - a) * s;
  for (let i = 0; i < nseg; i++) {
    const sMid = (i + 0.5) / nseg;                 // fracción a la mitad del tramo
    const D = lerp(Dbase, Dtop, sMid);
    const t = lerp(tbase, ttop, sMid);
    const ts = tubeSection(D, t);
    const sec = model.addSection({
      name: `Tubo Ø${(D).toFixed(2)}×${(t * 1000).toFixed(0)}mm`,
      A: ts.A, Iz: ts.I, Iy: ts.I, J: ts.J,
      Avy: ts.Av, Avz: ts.Av, kappay: 0.5, kappaz: 0.5,
    });
    secIds.push(sec.id);
    const el = model.addElement(towerNodes[i], towerNodes[i + 1], mat.id, sec.id);
    if (el) { el.macro = macroId; el.macroType = 'turbine'; elemIds.push(el.id); }
  }

  // ── RNA: masa concentrada excéntrica + brazo rígido al tope ───────────────
  const rna = model.addNode(x0 + eRNA, y0, z0 + H);
  model.updateNode(rna.id, { nodeMass: { mx: mRNA, my: mRNA, mz: mRNA } });
  const link = model.addLink({ master: topNode, slave: rna.id, rigid: true });

  // ── Fundación ─────────────────────────────────────────────────────────────
  let buriedNode = null;
  if (baseType === 1) {
    // Empotramiento aparente: pila equivalente enterrada (sección = tramo base).
    buriedNode = model.addNode(x0, y0, z0 - Lf, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 }).id;
    const ts = tubeSection(Dbase, tbase);
    const sec = model.addSection({
      name: `Pila equiv. Ø${Dbase.toFixed(2)}`,
      A: ts.A, Iz: ts.I, Iy: ts.I, J: ts.J, Avy: ts.Av, Avz: ts.Av, kappay: 0.5, kappaz: 0.5,
    });
    secIds.push(sec.id);
    const el = model.addElement(buriedNode, base.id, mat.id, sec.id);
    if (el) { el.macro = macroId; el.macroType = 'turbine'; elemIds.push(el.id); }
  } else {
    // Resortes lineales desacoplados en la base (lateral + rocking + vertical + torsional).
    model.updateNode(base.id, { springs: { kux: kL, kuy: kL, kuz: kV, krx: kR, kry: kR, krz: kT } });
  }

  // Nodo medio (≈ H/2) para el 2º acelerómetro MEMS.
  const midNode = towerNodes.reduce((best, id) => {
    const z = model.nodes.get(id).z;
    return Math.abs(z - (z0 + H / 2)) < Math.abs(model.nodes.get(best).z - (z0 + H / 2)) ? id : best;
  }, towerNodes[0]);

  // ── Registro del macro (identificar/borrar como entidad) ──────────────────
  if (!model.macros) model.macros = new Map();
  model.macros.set(macroId, {
    id: macroId, type: 'turbine',
    baseNode: base.id, towerNodes, topNode, midNode, rnaNode: rna.id, buriedNode,
    elemIds, matId: mat.id, secIds, linkId: link.id,
    props: { H, Dbase, Dtop, tbase, ttop, nseg, mRNA, eRNA, E, nu, rho, kL, kR, kV, kT, baseType, Lf },
    // Sensores SHM: 2 acelerómetros MEMS (tope + centro) + gateway en la base.
    sensors: [
      { id: 'acc-top', node: topNode, label: 'Acelerómetro superior' },
      { id: 'acc-mid', node: midNode, label: 'Acelerómetro central' },
    ],
    gateway: { node: base.id, label: 'Gateway CPU' },
  });

  return { macroId, towerNodes, topNode, midNode, rnaNode: rna.id, baseNode: base.id, elemIds };
}

// ── Registro del macromodelo «Torre eólica» (wind-shm) ───────────────────────
registerMacro({
  id: 'turbine',
  name: 'Torre eólica — gemelo digital',
  desc: 'Aerogenerador onshore: fuste cónico (Timoshenko) + RNA (masa excéntrica con brazo rígido) + fundación (resortes lineales o pila enterrada).',
  nodes: 1,
  nodesHint: 'el nodo base de la torre (a nivel de fundación)',
  dims: '3D',
  params: [
    { key: 'H',     label: 'Altura de buje H (m)',          default: 90,    step: 1,    min: 1 },
    { key: 'Dbase', label: 'Diámetro base (m)',             default: 4.3,   step: 0.1,  min: 0.1 },
    { key: 'Dtop',  label: 'Diámetro tope (m)',             default: 2.9,   step: 0.1,  min: 0.1 },
    { key: 'tbase', label: 'Espesor base (m)',              default: 0.030, step: 0.001, min: 0.001 },
    { key: 'ttop',  label: 'Espesor tope (m)',              default: 0.015, step: 0.001, min: 0.001 },
    { key: 'nseg',  label: 'Nº de tramos',                  default: 10,    step: 1,    min: 2 },
    { key: 'mRNA',  label: 'Masa RNA rotor+góndola (ton)',  default: 130,   step: 5,    min: 0 },
    { key: 'eRNA',  label: 'Excentricidad CG RNA (m)',      default: 2.0,   step: 0.1,  min: 0 },
    { key: 'E',     label: 'E acero (kN/m²)',               default: 2.1e8, step: 1e6,  min: 1 },
    { key: 'rho',   label: 'Densidad acero (ton/m³)',       default: 7.85,  step: 0.05, min: 0 },
    { key: 'kL',    label: 'Resorte lateral kL (kN/m)',     default: 5.0e6, step: 1e5,  min: 0 },
    { key: 'kR',    label: 'Resorte rocking kR (kN·m/rad)', default: 1.0e9, step: 1e7,  min: 0 },
    { key: 'kV',    label: 'Resorte vertical kV (kN/m)',    default: 5.0e6, step: 1e5,  min: 0 },
    { key: 'kT',    label: 'Resorte torsional kT (kN·m/rad)', default: 1.0e9, step: 1e7, min: 0 },
    { key: 'baseType', label: 'Fundación (0=resortes, 1=enterrada)', default: 0, step: 1, min: 0 },
    { key: 'Lf',    label: 'Largo enterrado Lf (m) [si=1]', default: 10,    step: 1,    min: 1 },
  ],
  expand: (model, nodeIds, props) => insertTurbine(model, nodeIds, props),
});
