// ─────────────────────────────────────────────────────────────────────────────
// digital_twin.js — GEMELO DIGITAL (ReWind).
//
// Corre el SOLVER MODAL real de PÓRTICO sobre los modelos FE de las estructuras
// para obtener su frecuencia natural f₁ (línea base SHM). La torre eólica usa el
// macromodelo `turbine`; la torre de alta tensión usa el generador de torres de
// PÓRTICO (celosía 3D). Requiere numeric.js (presente en el navegador).
// ─────────────────────────────────────────────────────────────────────────────
import { Model } from '../model/model.js?v=199';
import { Serializer } from '../model/serializer.js?v=199';
import { insertTurbine } from '../model/macros/turbine.js?v=199';
import { ModalSolver } from '../solver/modal_solver.js?v=199';
import { generarTorre } from '../../asistente/generador.js?v=199';

// f₁ del aerogenerador (macromodelo: fuste cónico + RNA + resortes de fundación).
export function turbineF1() {
  const m = new Model();
  const base = m.addNode(0, 0, 0);
  insertTurbine(m, [base.id], {});
  return new ModalSolver().solve(m, 3).freq[0];
}

// f₁ de la torre de alta tensión (celosía 3D generada por PÓRTICO, nudos rígidos).
export function hvF1() {
  const model = generarTorre(
    { torre: { altura_m: 42, base_m: 7, cima_m: 2.5, paneles: 7, rotulado: false,
      crucetas: [{ z_m: 33, largo_m: 7 }, { z_m: 39, largo_m: 5 }] } },
    { materiales: [], perfiles: [] });
  const m = new Serializer().fromJSON(JSON.stringify(model));
  return new ModalSolver().solve(m, 3).freq[0];
}

// Calcula ambas f₁ (una por tipo; todas las torres del tipo comparten valor).
export function computeTwin() {
  const out = {};
  try { out.turbine = turbineF1(); } catch (e) { console.warn('[twin] turbina:', e.message); }
  try { out.hv = hvF1(); } catch (e) { console.warn('[twin] torre AT:', e.message); }
  return out;
}
