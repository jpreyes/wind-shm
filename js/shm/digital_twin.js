// ─────────────────────────────────────────────────────────────────────────────
// digital_twin.js — GEMELO DIGITAL (ReWind).
//
// Corre el SOLVER MODAL FEM real sobre los modelos FE de las estructuras
// para obtener su frecuencia natural f₁ (línea base SHM). La torre eólica usa el
// macromodelo `turbine`; la torre de alta tensión usa el generador de torres de
// celosía 3D. Requiere numeric.js (presente en el navegador).
// ─────────────────────────────────────────────────────────────────────────────
import { Model } from '../model/model.js?v=315';
import { Serializer } from '../model/serializer.js?v=315';
import { insertTurbine } from '../model/macros/turbine.js?v=315';
import { ModalSolver } from '../solver/modal_solver.js?v=315';
import { StaticSolver } from '../solver/static_solver.js?v=315';
import { generarTorre } from '../../asistente/generador.js?v=315';

// f₁ del aerogenerador (macromodelo: fuste cónico + RNA + resortes de fundación).
export function turbineF1() {
  const m = new Model();
  const base = m.addNode(0, 0, 0);
  insertTurbine(m, [base.id], {});
  return new ModalSolver().solve(m, 3).freq[0];
}

// f₁ de la torre de alta tensión (celosía 3D generada por el solver, nudos rígidos).
export function hvF1() {
  const model = generarTorre(
    { torre: { altura_m: 42, base_m: 7, cima_m: 2.5, paneles: 7, rotulado: false,
      crucetas: [{ z_m: 33, largo_m: 7 }, { z_m: 39, largo_m: 5 }] } },
    { materiales: [], perfiles: [] });
  const m = new Serializer().fromJSON(JSON.stringify(model));
  return new ModalSolver().solve(m, 3).freq[0];
}

// Diagramas N/V/M del fuste de la turbina bajo peso propio + empuje del rotor (viento).
// Devuelve un perfil [{z, N, V, M}] a lo alto del mástil (kN, kN·m).
export function turbineDiagram() {
  const m = new Model();
  const base = m.addNode(0, 0, 0);
  const r = insertTurbine(m, [base.id], {});
  const macro = m.macros.get(r.macroId);
  const lc = m.addLoadCase('Viento+PP', true);                 // peso propio incluido
  m.addLoad(lc.id, { type: 'nodal', nodeId: macro.topNode, F: [500, 0, 0, 0, 0, 0] }); // empuje ~500 kN
  const res = new StaticSolver().solve(m, lc.id, true);
  const set = new Set(macro.towerNodes);
  const segs = macro.elemIds.map(id => m.elements.get(id)).filter(e => e && set.has(e.n1) && set.has(e.n2));
  const prof = [];
  for (const e of segs) for (const [xi, nid] of [[0, e.n1], [1, e.n2]]) {
    const v = res.getElemAtXi(e.id, xi), z = m.nodes.get(nid).z;
    prof.push({ z, N: Math.abs(v.N), V: Math.hypot(v.Vy || 0, v.Vz || 0), M: Math.hypot(v.My || 0, v.Mz || 0),
                disp: Math.hypot(v.ux || 0, v.uy || 0, v.uz || 0) });   // desplazamiento total (m)
  }
  prof.sort((a, b) => a.z - b.z);
  return prof;
}

// Esfuerzo axial máx (tracción/compresión) en las barras de la torre AT bajo viento.
export function hvAxial() {
  const model = generarTorre(
    { torre: { altura_m: 42, base_m: 7, cima_m: 2.5, paneles: 7, rotulado: false,
      crucetas: [{ z_m: 33, largo_m: 7 }, { z_m: 39, largo_m: 5 }] } },
    { materiales: [], perfiles: [] });
  const m = new Serializer().fromJSON(JSON.stringify(model));
  const res = new StaticSolver().solve(m, 2, false);            // caso 2 = Viento (generarTorre)
  let tMax = 0, cMax = 0;
  for (const e of m.elements.values()) { const N = res.getElemAtXi(e.id, 0.5).N; if (N > tMax) tMax = N; if (N < cMax) cMax = N; }
  // Perfil de desplazamiento lateral vs altura (de las patas, no de los anillos).
  const profile = [];
  for (const e of m.elements.values()) {
    const n1 = m.nodes.get(e.n1), n2 = m.nodes.get(e.n2);
    if (!n1 || !n2 || Math.abs(n1.z - n2.z) < 0.5) continue;     // saltar horizontales/crucetas planas
    for (const [xi, nd] of [[0, n1], [1, n2]]) { const v = res.getElemAtXi(e.id, xi); profile.push({ z: nd.z, disp: Math.hypot(v.ux || 0, v.uy || 0, v.uz || 0) }); }
  }
  profile.sort((a, b) => a.z - b.z);
  return { tMax, cMax, profile };
}

// Calcula f₁ (una por tipo) + diagramas del gemelo.
export function computeTwin() {
  const out = {};
  try { out.turbine = turbineF1(); } catch (e) { console.warn('[twin] turbina:', e.message); }
  try { out.hv = hvF1(); } catch (e) { console.warn('[twin] torre AT:', e.message); }
  try { out.turbineProfile = turbineDiagram(); } catch (e) { console.warn('[twin] diagrama:', e.message); }
  try { out.hvAxial = hvAxial(); } catch (e) { console.warn('[twin] axial AT:', e.message); }
  return out;
}
