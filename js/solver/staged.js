// ──────────────────────────────────────────────────────────────────────────────
// staged.js — Análisis por ETAPAS CONSTRUCTIVAS (staged construction) · #59
//
// Un puente construido por voladizos sucesivos, empuje (launching) o dovelas no
// se comporta como la estructura terminada cargada de golpe: cada elemento «nace»
// en la geometría deformada del momento en que se activa y sólo acumula esfuerzos
// de las etapas en que ya existe. La clave es que el ESTADO se ACUMULA por fase.
//
// Modelo lineal incremental (pequeños desplazamientos):
//   · El conjunto de elementos ACTIVOS crece/decrece por etapa.
//   · En cada etapa se ensambla K SÓLO con los elementos activos y se resuelve el
//     INCREMENTO de carga de esa etapa:  Kactivo · ΔU = ΔF.
//   · U y los esfuerzos de cada elemento se ACUMULAN sumando los incrementos de las
//     etapas en que el elemento estaba activo.  Un elemento recién activado NO siente
//     la deformación previa (sólo los incrementos desde su activación) → arranca
//     libre de tensión, como en SAP2000/CSiBridge (staged construction).
//
// Verificable: un voladizo apuntalado por etapas (cargar → apuntalar → cargar) da
// flecha y momentos DISTINTOS a la misma estructura cargada monolíticamente — y
// cada uno coincide con la solución analítica de viga (ver test_staged.mjs).
//
// Limitación deliberada: sólo elementos de barra (frame). Áreas/diafragmas se
// ignoran en el ensamble por etapas (los puentes staged son reticulados/vigas).
// ──────────────────────────────────────────────────────────────────────────────
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from './assembler.js?v=194';
import { Results } from './postprocess.js?v=194';

// Campos numéricos de los esfuerzos de extremo que se ACUMULAN entre etapas.
const EF_KEYS = ['N','Vy1','Vz1','T','My1','Mz1','Vy2','Vz2','My2','Mz2',
                 'qy','qz','qy1','qy2','qz1','qz2'];

// Construye un «view» liviano del modelo con SÓLO los elementos activos y un caso
// de carga incremental sintético. Comparte nodos/materiales/secciones por referencia.
function makeView(model, activeIds, incLoads) {
  const elements = new Map();
  for (const id of activeIds) { const e = model.elements.get(id); if (e) elements.set(id, e); }
  const lc = { id: -1, name: '_stage', loads: incLoads, selfWeight: false, type: 'static', specDir: null };
  return {
    nodes: model.nodes, elements, areas: new Map(), diaphragms: new Map(),
    materials: model.materials, sections: model.sections,
    loadCases: new Map([[-1, lc]]), combinations: new Map(),
    mode: model.mode, units: model.units,
  };
}

export class StagedSolver {
  /**
   * @param {Model}  model
   * @param {Array}  stages  — lista ordenada de etapas:
   *    { name, activate:[elemId…], deactivate:[elemId…], loads:[…], selfWeightNew:bool }
   *    `loads`         = cargas AÑADIDAS en esta etapa (persisten), formato modelo
   *                      ({type:'nodal',nodeId,F} | {type:'dist',elemId,dir,w[,w2]}).
   *    `selfWeightNew` = aplicar el peso propio de los elementos recién activados
   *                      (típico: cada dovela trae su peso al colarse). Por defecto true.
   * @returns adaptador con getNodeDisp/getReaction/getElemForces + .stages[]
   */
  solve(model, stages) {
    const num = (typeof window !== 'undefined' && window.numeric) || (typeof globalThis !== 'undefined' && globalThis.numeric);
    if (!num) throw new Error('numeric.js no está disponible');

    const ni   = buildNodeIndex(model);
    const nDOF = ni.size * 6;
    const is2D = model.mode === '2D';

    const U         = new Float64Array(nDOF);   // desplazamiento acumulado
    const Racc      = new Float64Array(nDOF);   // reacciones acumuladas
    const efAcc     = new Map();                 // elemId → esfuerzos acumulados
    const active    = new Set();                 // elementos activos
    const everActive= new Set();                 // para detectar «recién activado»
    const stageOut  = [];

    // Restricciones EFECTIVAS por nodo (copia mutable). Una etapa puede AÑADIR o
    // QUITAR apoyos (falsework, puntales, cimbra) vía stage.supports. Al añadir un
    // apoyo en una etapa tardía, el desplazamiento ya acumulado del nodo queda
    // «congelado» (sólo se restringen los incrementos futuros), como en la realidad.
    const restr = new Map();
    for (const node of model.nodes.values()) restr.set(node.id, { ...node.restraints });

    for (const stage of stages) {
      for (const sp of (stage.supports || [])) {
        const r = restr.get(sp.node ?? sp.nodeId); if (!r) continue;
        for (const k of ['ux','uy','uz','rx','ry','rz']) if (sp[k] !== undefined) r[k] = sp[k] ? 1 : 0;
      }
      for (const id of (stage.deactivate || [])) active.delete(id);
      const newlyActive = [];
      for (const id of (stage.activate || [])) {
        if (model.elements.has(id)) { active.add(id); if (!everActive.has(id)) { newlyActive.push(id); everActive.add(id); } }
      }

      // Cargas incrementales de la etapa = cargas declaradas + peso propio de los
      // elementos recién activados (como dist gravity explícita).
      const incLoads = [...(stage.loads || [])];
      const swNew = stage.selfWeightNew !== false;
      if (swNew) for (const id of newlyActive) {
        const el = model.elements.get(id);
        const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
        if (mat && sec && mat.rho > 0) incLoads.push({ type: 'dist', elemId: id, dir: 'gravity', w: +(mat.rho * sec.A) });
      }

      const view = makeView(model, active, incLoads);
      const { K } = assembleK(view, ni);
      const F = assembleF(view, ni, -1, false);

      // Nodos «conectados» a la estructura activa (extremos de algún elemento activo).
      const activeNodes = new Set();
      for (const id of active) { const e = model.elements.get(id); activeNodes.add(e.n1); activeNodes.add(e.n2); }

      // Clasificación de GDL: libre sólo si el nodo está activo y el GDL no está
      // restringido (ni fuera de plano en 2D). Los GDL de nodos inactivos quedan
      // fijos (ΔU=0) — todavía no existen en esta etapa.
      const freeDOF = [], fixedDOF = [];
      for (const node of model.nodes.values()) {
        const d = getNodeDOFs(ni, node.id), r = restr.get(node.id);
        const isActiveNode = activeNodes.has(node.id);
        const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
        d.forEach((gi, li) => { (isActiveNode && !rArr[li]) ? freeDOF.push(gi) : fixedDOF.push(gi); });
      }
      if (!freeDOF.length) { stageOut.push({ name: stage.name, dU: 0, active: new Set(active) }); continue; }

      const nF = freeDOF.length;
      const Kff = Array.from({ length: nF }, (_, i) => { const row = new Float64Array(nF), ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) row[j] = K[ri + freeDOF[j]]; return [...row]; });
      const Ff  = freeDOF.map(di => F[di]);

      let duf;
      try { duf = num.solve(Kff, Ff); }
      catch (e) { throw new Error(`Etapa «${stage.name}»: el solver falló (${e.message}). ¿La subestructura activa es estable?`); }
      if (!duf || duf.some(v => !Number.isFinite(v)))
        throw new Error(`Etapa «${stage.name}»: subestructura INESTABLE (mecanismo). Revise apoyos/elementos activos.`);

      const dU = new Float64Array(nDOF);
      freeDOF.forEach((gi, i) => { dU[gi] = duf[i]; });

      // Reacciones incrementales = K·ΔU − ΔF en los GDL restringidos.
      const dR = new Float64Array(nDOF);
      for (const gi of fixedDOF) { let s = 0; const ri = gi * nDOF; for (let j = 0; j < nDOF; j++) s += K[ri + j] * dU[j]; dR[gi] = s - F[gi]; }

      // Acumula desplazamientos y reacciones.
      for (let i = 0; i < nDOF; i++) { U[i] += dU[i]; Racc[i] += dR[i]; }

      // Esfuerzos incrementales de los elementos activos (incluye FEF de las cargas
      // de esta etapa) → acumular. Un elemento recién activado sólo recibe sus
      // incrementos desde ahora (nace libre de tensión).
      const incRes = new Results(view, ni, dU, dR, F, -1, false);
      let dUmax = 0; for (const gi of freeDOF) dUmax = Math.max(dUmax, Math.abs(dU[gi]));
      for (const id of active) {
        const ef = incRes.getElemForces(id); if (!ef) continue;
        let acc = efAcc.get(id);
        if (!acc) { acc = { ex: ef.ex, ey: ef.ey, ez: ef.ez, L: ef.L, EIz: ef.EIz, EIy: ef.EIy }; for (const k of EF_KEYS) acc[k] = 0; efAcc.set(id, acc); }
        for (const k of EF_KEYS) acc[k] += (ef[k] || 0);
      }
      stageOut.push({ name: stage.name, dUmax, active: new Set(active), newlyActive: [...newlyActive] });
    }

    // Derivados de los esfuerzos acumulados (Vmax/Mmax/Nabs) para getSummary-like.
    for (const acc of efAcc.values()) {
      acc.Vmax = Math.max(Math.abs(acc.Vy1), Math.abs(acc.Vy2), Math.abs(acc.Vz1), Math.abs(acc.Vz2));
      acc.Mmax = Math.max(Math.abs(acc.Mz1), Math.abs(acc.Mz2), Math.abs(acc.My1), Math.abs(acc.My2));
      acc.Nabs = Math.abs(acc.N);
    }

    return {
      model, nodeIndex: ni, u: U, reactions: Racc, stages: stageOut,
      getNodeDisp: (id) => getNodeDOFs(ni, id).map(i => U[i]),
      getReaction: (id) => getNodeDOFs(ni, id).map(i => Racc[i]),
      getElemForces: (id) => efAcc.get(id) || null,
      getMaxDisp: () => { let m = 0; for (const id of model.nodes.keys()) { const d = getNodeDOFs(ni, id).map(i => U[i]); m = Math.max(m, Math.hypot(d[0], d[1], d[2])); } return m; },
    };
  }
}
