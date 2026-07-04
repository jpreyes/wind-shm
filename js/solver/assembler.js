// ──────────────────────────────────────────────────────────────────────────────
// Assembler — builds global stiffness K and force vector F
// ──────────────────────────────────────────────────────────────────────────────
import {
  localAxes, stiffnessMatrix, massMatrix,
  transformMatrix, globalStiffness,
  applyReleases, fixedEndForces, condenseFEF,
  elemLocalK, elemLocalM
} from './timoshenko.js?v=309';
import { applyDiaphragmConstraints, applyDiaphragmMass } from './diaphragm.js?v=309';
import { applyLinkConstraints } from './links.js?v=309';
import { assembleAreasInto, assembleAreasMassInto, areaThermalContribs } from './membrane.js?v=309';

// ── Node index (contiguous 0-based numbering) ─────────────────────────────
export function buildNodeIndex(model) {
  const idx = new Map();
  let i = 0;
  for (const id of model.nodes.keys()) idx.set(id, i++);
  return idx;
}

// DOF indices for a node (0-based index → 6 global DOFs)
function dofs(nodeIndex, nodeId) {
  const i = nodeIndex.get(nodeId);
  const b = 6 * i;
  return [b, b+1, b+2, b+3, b+4, b+5];
}

// ── Global stiffness matrix ────────────────────────────────────────────────
/**
 * Returns K as a flat Float64Array (nDOF × nDOF, row-major)
 * Also returns mass matrix M (for modal analysis later)
 */
export function assembleK(model, nodeIndex) {
  const nDOF = nodeIndex.size * 6;
  const K = new Float64Array(nDOF * nDOF);
  const M = new Float64Array(nDOF * nDOF);

  for (const elem of model.elements.values()) {
    const n1  = model.nodes.get(elem.n1);
    const n2  = model.nodes.get(elem.n2);
    const mat = model.materials.get(elem.matId);
    const sec = model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) continue;

    const { ex, ey, ez, L } = localAxes(n1, n2);
    let Ke = elemLocalK(elem, mat, sec, L);   // incluye cacho rígido (#87) si lo tiene
    const Me = elemLocalM(elem, mat, sec, L);

    // Apply end releases (hinges)
    const hasRelease = elem.releases?.some(r => r !== 0);
    if (hasRelease) {
      Ke = applyReleases(Ke, elem.releases.map(r => r !== 0));
    }

    const T   = transformMatrix(ex, ey, ez);
    const KG  = globalStiffness(Ke, T);
    const MG  = globalStiffness(Me, T);

    // Element DOF mapping
    const ed  = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];

    // Add to global matrices
    for (let i=0; i<12; i++) {
      for (let j=0; j<12; j++) {
        K[ed[i]*nDOF + ed[j]] += KG[i][j];
        M[ed[i]*nDOF + ed[j]] += MG[i][j];
      }
    }
  }

  // Apoyos elásticos: rigidez de resorte en la diagonal de los GDL globales
  for (const node of model.nodes.values()) {
    const sp = node.springs;
    if (!sp) continue;
    const ks = [sp.kux, sp.kuy, sp.kuz, sp.krx, sp.kry, sp.krz];
    if (!ks.some(k => k > 0)) continue;
    const b = nodeIndex.get(node.id) * 6;
    for (let i = 0; i < 6; i++) {
      if (ks[i] > 0) K[(b + i) * nDOF + (b + i)] += ks[i];
    }
  }

  // Elementos de área (membrana CST/QUAD) → GDL de traslación globales
  assembleAreasInto({ add: (i, j, v) => { K[i * nDOF + j] += v; } }, model, nodeIndex);
  // Masa de las áreas (ρ·t·A lumped) para el modal
  assembleAreasMassInto({ add: (i, j, v) => { M[i * nDOF + j] += v; } }, model, nodeIndex);

  // Apply rigid diaphragm constraints (penalty method)
  applyDiaphragmConstraints(K, model, nodeIndex, nDOF);

  // Apply link/coupling constraints (tablero↔viga, offsets) — penalty method
  applyLinkConstraints(K, model, nodeIndex, nDOF);

  // Apply diaphragm concentrated masses (for modal analysis)
  applyDiaphragmMass(M, model, nodeIndex, nDOF);

  // Apply user-defined nodal point masses (mx, my, mz in ton)
  for (const node of model.nodes.values()) {
    const nm = node.nodeMass;
    if (!nm || (nm.mx === 0 && nm.my === 0 && nm.mz === 0)) continue;
    const b = nodeIndex.get(node.id) * 6;
    M[b*nDOF     + b    ] += nm.mx || 0;   // Ux
    M[(b+1)*nDOF + (b+1)] += nm.my || 0;   // Uy
    M[(b+2)*nDOF + (b+2)] += nm.mz || 0;   // Uz
  }

  return { K, M, nDOF };
}

// ── Force vector assembly ─────────────────────────────────────────────────
/**
 * Builds force vector F from load case (lcId).
 * Also applies self-weight if selfWeight=true.
 */
export function assembleF(model, nodeIndex, lcId, selfWeight = false) {
  const nDOF = nodeIndex.size * 6;
  const F = new Float64Array(nDOF);

  // Load case loads
  const lc = model.loadCases.get(lcId);
  if (lc) {
    for (const load of lc.loads) {
      if (load.type === 'nodal') {
        const nd = model.nodes.get(load.nodeId);
        if (!nd) continue;
        const d = dofs(nodeIndex, nd.id);
        for (let i=0; i<6; i++) F[d[i]] += (load.F[i] || 0);
      }

      if (load.type === 'dist') {
        const elem = model.elements.get(load.elemId);
        if (!elem) continue;
        const n1  = model.nodes.get(elem.n1);
        const n2  = model.nodes.get(elem.n2);
        const mat = model.materials.get(elem.matId);
        const sec = model.sections.get(elem.secId);
        if (!n1 || !n2) continue;

        const { ex, ey, ez, L } = localAxes(n1, n2);
        const T = transformMatrix(ex, ey, ez);
        const hasRelease = elem.releases?.some(r => r !== 0);
        const relBool    = hasRelease ? elem.releases.map(r => r !== 0) : null;
        const Ke_loc     = (hasRelease && mat && sec) ? stiffnessMatrix(L, mat, sec) : null;

        const ed = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];
        for (const ll of _toLocalDistLoad(load, ex, ey, ez)) {
          let f_local = fixedEndForces(L, ll);
          if (Ke_loc) f_local = condenseFEF(Ke_loc, relBool, f_local);
          const f_global = Array(12).fill(0);
          for (let i=0; i<12; i++)
            for (let j=0; j<12; j++)
              f_global[i] += T[j][i] * f_local[j];
          for (let i=0; i<12; i++) F[ed[i]] -= f_global[i];
        }
      }

      // Carga de TEMPERATURA uniforme ΔT: el elemento quiere dilatarse α·ΔT·L.
      // FEF térmica (igual convención que las distribuidas, F -= FEF):
      //   axial nodo1 = +EA·α·ΔT,  axial nodo2 = −EA·α·ΔT  (resto 0).
      // Barra libre → N=0 (dilata α·ΔT·L); empotrada → N=−EA·α·ΔT.
      // Temperatura sobre un ÁREA: carga térmica de superficie (membrana) + un
      // GRADIENTE a través del espesor (momento térmico de flexión, #57).
      // Caras: dTtop = cara +z (roja), dTbot = cara −z (azul). Media → membrana;
      // gradiente (dTbot − dTtop) → momento. Compatible con el ΔT uniforme legado (dT).
      if (load.type === 'temp' && load.areaId != null) {
        const area = model.areas.get(load.areaId);
        if (!area) continue;
        const hasFaces = load.dTtop != null || load.dTbot != null;
        const dTmean = hasFaces ? ((+load.dTtop || 0) + (+load.dTbot || 0)) / 2 : (load.dT || 0);
        // gradiente = cara caliente abajo (−z) → la placa curva hacia +z (la cara
        // más caliente se alarga y queda convexa). gradT = T(−z) − T(+z).
        const gradT  = hasFaces ? ((+load.dTbot || 0) - (+load.dTtop || 0)) : 0;
        for (const { dof, val } of areaThermalContribs(area, model, nodeIndex, dTmean, gradT)) F[dof] += val;
        continue;
      }

      if (load.type === 'temp') {
        const elem = model.elements.get(load.elemId);
        if (!elem) continue;
        const n1  = model.nodes.get(elem.n1);
        const n2  = model.nodes.get(elem.n2);
        const mat = model.materials.get(elem.matId);
        const sec = model.sections.get(elem.secId);
        if (!n1 || !n2 || !mat || !sec) continue;

        const { ex, ey, ez, L } = localAxes(n1, n2);
        const T  = transformMatrix(ex, ey, ez);
        const EA = mat.E * sec.A * (sec.mod?.A ?? 1);
        const Nt = EA * (mat.alpha ?? 0) * (load.dT || 0);
        let f_local = Array(12).fill(0);
        f_local[0] = +Nt; f_local[6] = -Nt;
        const hasRelease = elem.releases?.some(r => r !== 0);
        if (hasRelease) f_local = condenseFEF(stiffnessMatrix(L, mat, sec), elem.releases.map(r => r !== 0), f_local);
        const ed = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];
        const f_global = Array(12).fill(0);
        for (let i=0; i<12; i++)
          for (let j=0; j<12; j++)
            f_global[i] += T[j][i] * f_local[j];
        for (let i=0; i<12; i++) F[ed[i]] -= f_global[i];
      }
    }
  }

  // Self-weight: gravity in -Z direction — full FEF (forces + moments)
  if (selfWeight) {
    for (const elem of model.elements.values()) {
      const n1  = model.nodes.get(elem.n1);
      const n2  = model.nodes.get(elem.n2);
      const mat = model.materials.get(elem.matId);
      const sec = model.sections.get(elem.secId);
      if (!n1 || !n2 || !mat || !sec) continue;

      const { ex, ey, ez, L } = localAxes(n1, n2);
      const T  = transformMatrix(ex, ey, ez);
      const ed = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];
      const hasRel_sw  = elem.releases?.some(r => r !== 0);
      const relBool_sw = hasRel_sw ? elem.releases.map(r => r !== 0) : null;
      const Ke_loc_sw  = hasRel_sw ? stiffnessMatrix(L, mat, sec) : null;
      const swLoad = { w: +(mat.rho * sec.A), dir: 'gravity' };
      for (const ll of _toLocalDistLoad(swLoad, ex, ey, ez)) {
        let f_local = fixedEndForces(L, ll);
        if (Ke_loc_sw) f_local = condenseFEF(Ke_loc_sw, relBool_sw, f_local);
        const f_global = Array(12).fill(0);
        for (let i=0; i<12; i++)
          for (let j=0; j<12; j++)
            f_global[i] += T[j][i] * f_local[j];
        for (let i=0; i<12; i++) F[ed[i]] -= f_global[i];
      }
    }
  }

  return F;
}

// ── Helpers ───────────────────────────────────────────────────────────────
// Returns array of {dir, w} components in local coordinates (x, y and z).
// 'gravity' and legacy 'globalZ' both map to Global -Z (positive w = downward).
// Includes axial projection so gravity on vertical columns gets correct axial FEF.
function _toLocalDistLoad(load, ex, ey, ez) {
  const w   = load.w;
  const w2  = (load.w2 == null) ? w : load.w2;   // trapecial: intensidad en el extremo j
  const dir = load.dir || 'gravity';

  if (dir === 'localY') return [{ dir: 'y', w, w2 }];
  if (dir === 'localZ') return [{ dir: 'z', w, w2 }];
  if (dir === 'localX') return [{ dir: 'x', w, w2 }];

  const g = dir === 'globalX' ? [1,0,0]
          : dir === 'globalY' ? [0,1,0]
          : [0,0,-1];   // 'gravity' and legacy 'globalZ' both mean downward (positive w = ↓)

  // Misma proyección para ambos extremos (la dirección no cambia a lo largo).
  const px = g[0]*ex[0] + g[1]*ex[1] + g[2]*ex[2];
  const py = g[0]*ey[0] + g[1]*ey[1] + g[2]*ey[2];
  const pz = g[0]*ez[0] + g[1]*ez[1] + g[2]*ez[2];
  const res = [];
  if (Math.abs(w*px) > 1e-14 || Math.abs(w2*px) > 1e-14) res.push({ dir: 'x', w: w*px, w2: w2*px });
  if (Math.abs(w*py) > 1e-14 || Math.abs(w2*py) > 1e-14) res.push({ dir: 'y', w: w*py, w2: w2*py });
  if (Math.abs(w*pz) > 1e-14 || Math.abs(w2*pz) > 1e-14) res.push({ dir: 'z', w: w*pz, w2: w2*pz });
  return res;
}

// ── Export DOF helper (used by solver) ────────────────────────────────────
export { dofs as getNodeDOFs };
