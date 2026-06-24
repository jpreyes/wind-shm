// ──────────────────────────────────────────────────────────────────────────────
// io/neutral.js — MODELO NEUTRO de intercambio (#74, G18)
//
// Representación intermedia, independiente de cualquier programa, entre el `Model` de
// PÓRTICO y los formatos externos (VECTOR, SAP2000, ETABS, Abaqus/Calculix, OpenSees,
// SOFISTIK…).  Cada adaptador de formato sólo traduce  texto ↔ MODELO NEUTRO  (ver
// `registry.js`), nunca toca el `Model` directamente → agregar un motor nuevo = escribir
// un adaptador `{ read, write }`.  Unidades del intercambio: SI coherente (m, kN, kN/m²).
//
// El modelo neutro usa ids 1..N CONSECUTIVOS (los formatos externos suelen exigirlo);
// la conversión guarda el remapeo para no perder la conectividad.  AUTÓNOMO (Node+browser).
// ──────────────────────────────────────────────────────────────────────────────
import { Model } from '../model/model.js?v=204';

/** `Model` de PÓRTICO → modelo neutro (ids renumerados 1..N). */
export function modelToNeutral(model) {
  const warnings = [];

  const nodeIdx = new Map(); let ni = 0;
  const nodes = [];
  for (const n of model.nodes.values()) {
    nodeIdx.set(n.id, ++ni);
    const m = n.nodeMass;
    nodes.push({
      id: ni, x: n.x, y: n.y, z: n.z,
      restraints: { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0, ...(n.restraints || {}) },
      mass: (m && (m.mx || m.my || m.mz)) ? { mx: m.mx || 0, my: m.my || 0, mz: m.mz || 0 } : null,
    });
  }

  const matIdx = new Map(); let mi = 0; const materials = [];
  for (const mat of model.materials.values()) {
    matIdx.set(mat.id, ++mi);
    materials.push({ id: mi, name: mat.name, E: mat.E, G: mat.G, nu: mat.nu, rho: mat.rho, alpha: mat.alpha });
  }

  const secIdx = new Map(); let si = 0; const sections = [];
  for (const s of model.sections.values()) {
    secIdx.set(s.id, ++si);
    sections.push({ id: si, name: s.name, A: s.A, Iz: s.Iz, Iy: s.Iy, J: s.J, Avy: s.Avy, Avz: s.Avz });
  }

  const memIdx = new Map(); let ei = 0; const members = [];
  for (const e of model.elements.values()) {
    memIdx.set(e.id, ++ei);
    members.push({
      id: ei, ni: nodeIdx.get(e.n1), nj: nodeIdx.get(e.n2),
      mat: matIdx.get(e.matId) || 1, sec: secIdx.get(e.secId) || 1,
      releases: (e.releases || Array(12).fill(0)).slice(), beta: 0,
    });
  }
  if (model.areas && model.areas.size) warnings.push(`${model.areas.size} elemento(s) de área no se exportan (sólo barras por ahora)`);

  const loadCases = [];
  for (const lc of model.loadCases.values()) {
    const loads = [];
    for (const ld of (lc.loads || [])) {
      if (ld.type === 'nodal' && nodeIdx.has(ld.nodeId)) loads.push({ type: 'nodal', node: nodeIdx.get(ld.nodeId), F: (ld.F || []).slice(0, 6) });
      else if (ld.type === 'dist' && memIdx.has(ld.elemId)) loads.push({ type: 'dist', member: memIdx.get(ld.elemId), w: ld.w, w2: ld.w2, dir: ld.dir || 'gravity' });
    }
    loadCases.push({ id: lc.id, name: lc.name, selfWeight: !!lc.selfWeight, type: lc.type || 'static', loads });
  }

  return { units: { length: 'm', force: 'kN' }, meta: { name: model.name || 'PORTICO', source: 'portico', warnings }, nodes, materials, sections, members, loadCases };
}

/** Modelo neutro → `Model` nuevo de PÓRTICO (remapea ids; conserva conectividad). */
export function neutralToModel(neutral) {
  const model = new Model();
  // partir de un modelo vacío (sin los defaults de _initDefaults)
  model.nodes.clear(); model.elements.clear(); model.areas.clear();
  model.materials.clear(); model.sections.clear();
  model.loadCases.clear(); model.combinations.clear();

  const nodeId = new Map();
  for (const n of (neutral.nodes || [])) {
    const nn = model.addNode(n.x, n.y, n.z, n.restraints || {});
    nodeId.set(n.id, nn.id);
    if (n.mass) model.updateNode(nn.id, { nodeMass: n.mass });
  }

  const matId = new Map();
  for (const m of (neutral.materials || [])) {
    const G = m.G ?? (m.E / (2 * (1 + (m.nu ?? 0.2))));
    const mm = model.addMaterial({ name: m.name || 'Material', E: m.E, G, nu: m.nu ?? 0.2, rho: m.rho ?? 0, alpha: m.alpha ?? 1e-5 });
    matId.set(m.id, mm.id);
  }
  if (!neutral.materials || !neutral.materials.length) { const mm = model.addMaterial({ name: 'Genérico' }); matId.set(1, mm.id); }

  const secId = new Map();
  for (const s of (neutral.sections || [])) {
    const ss = model.addSection({
      name: s.name || 'Sección', A: s.A, Iz: s.Iz, Iy: s.Iy, J: s.J,
      Avy: s.Avy ?? (s.A ? s.A * 5 / 6 : undefined), Avz: s.Avz ?? (s.A ? s.A * 5 / 6 : undefined),
    });
    secId.set(s.id, ss.id);
  }
  if (!neutral.sections || !neutral.sections.length) { const ss = model.addSection({ name: 'Genérica' }); secId.set(1, ss.id); }

  const firstMat = matId.values().next().value, firstSec = secId.values().next().value;
  const memId = new Map();
  for (const e of (neutral.members || [])) {
    const el = model.addElement(nodeId.get(e.ni), nodeId.get(e.nj), matId.get(e.mat) ?? firstMat, secId.get(e.sec) ?? firstSec);
    if (el) { memId.set(e.id, el.id); if (e.releases && e.releases.some(Boolean)) model.updateElement(el.id, { releases: e.releases }); }
  }

  for (const lc of (neutral.loadCases || [])) {
    const c = model.addLoadCase(lc.name, lc.selfWeight, lc.type === 'spectrum' ? 'spectrum' : 'static');
    for (const ld of (lc.loads || [])) {
      if (ld.type === 'nodal' && nodeId.has(ld.node)) model.addLoad(c.id, { type: 'nodal', nodeId: nodeId.get(ld.node), F: (ld.F || []).slice(0, 6) });
      else if (ld.type === 'dist' && memId.has(ld.member)) model.addLoad(c.id, { type: 'dist', elemId: memId.get(ld.member), w: ld.w, w2: ld.w2, dir: ld.dir || 'gravity' });
    }
  }

  return model;
}
