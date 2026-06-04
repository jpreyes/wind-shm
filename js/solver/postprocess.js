// ──────────────────────────────────────────────────────────────────────────────
// Results — post-processing: displacements, internal forces, reactions
// ──────────────────────────────────────────────────────────────────────────────
import { localAxes, stiffnessMatrix, transformMatrix } from './timoshenko.js';
import { getNodeDOFs } from './assembler.js';

export class Results {
  constructor(model, nodeIndex, u, reactions, F_ext) {
    this.model      = model;
    this.nodeIndex  = nodeIndex;
    this.u          = u;          // Float64Array[nDOF] — global displacements
    this.reactions  = reactions;  // Float64Array[nDOF] — support reactions
    this.F_ext      = F_ext;      // Float64Array[nDOF] — external forces

    // Cache element forces
    this._elemForces = new Map();
    this._computeAllElemForces();
  }

  // ── Node displacements ────────────────────────────────────────────────────
  /** Returns [ux, uy, uz, rx, ry, rz] in global coords for a node */
  getNodeDisp(nodeId) {
    const d = getNodeDOFs(this.nodeIndex, nodeId);
    return d.map(i => this.u[i]);
  }

  /** Returns [Rx, Ry, Rz, Rmx, Rmy, Rmz] support reaction at node */
  getReaction(nodeId) {
    const d = getNodeDOFs(this.nodeIndex, nodeId);
    return d.map(i => this.reactions[i]);
  }

  /** Displaced node coordinates (for deformed shape) */
  getDeformedCoords(nodeId, scale = 1) {
    const node = this.model.nodes.get(nodeId);
    const d = this.getNodeDisp(nodeId);
    return {
      x: node.x + scale * d[0],
      y: node.y + scale * d[1],
      z: node.z + scale * d[2]
    };
  }

  /** Max absolute translational displacement (for auto-scale) */
  getMaxDisp() {
    let maxD = 0;
    for (const id of this.model.nodes.keys()) {
      const d = this.getNodeDisp(id);
      const mag = Math.sqrt(d[0]**2 + d[1]**2 + d[2]**2);
      if (mag > maxD) maxD = mag;
    }
    return maxD;
  }

  // ── Element internal forces ───────────────────────────────────────────────
  /**
   * Returns {N, Vy1, Vz1, T, My1, Mz1, Vy2, Vz2, My2, Mz2}
   * Positive N = tension, positive moments follow right-hand rule
   */
  getElemForces(elemId) {
    return this._elemForces.get(elemId);
  }

  _computeAllElemForces() {
    for (const elem of this.model.elements.values()) {
      this._elemForces.set(elem.id, this._computeElemForces(elem));
    }
  }

  _computeElemForces(elem) {
    const n1  = this.model.nodes.get(elem.n1);
    const n2  = this.model.nodes.get(elem.n2);
    const mat = this.model.materials.get(elem.matId);
    const sec = this.model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) return null;

    const { ex, ey, ez, L } = localAxes(n1, n2);
    const Ke_local = stiffnessMatrix(L, mat, sec);
    const T        = transformMatrix(ex, ey, ez);

    // Global element displacements
    const d1 = getNodeDOFs(this.nodeIndex, elem.n1);
    const d2 = getNodeDOFs(this.nodeIndex, elem.n2);
    const ue_global = [...d1, ...d2].map(i => this.u[i]);

    // Local displacements: ue_local = T · ue_global
    const ue_local = Array(12).fill(0);
    for (let i=0; i<12; i++)
      for (let j=0; j<12; j++)
        ue_local[i] += T[i][j] * ue_global[j];

    // Local forces: fe_local = Ke_local · ue_local
    const fe = Array(12).fill(0);
    for (let i=0; i<12; i++)
      for (let j=0; j<12; j++)
        fe[i] += Ke_local[i][j] * ue_local[j];

    // fe[0] is the restoring force at n1 in local x (axial reaction)
    // Axial tension = -fe[0] (positive = tension, negative = compression)
    return {
      N:    -fe[0],     // Axial force (+ tension)
      Vy1:   fe[1],     // Shear local y at n1
      Vz1:   fe[2],     // Shear local z at n1
      T:     fe[3],     // Torsion
      My1:   fe[4],     // Moment about local y at n1
      Mz1:   fe[5],     // Moment about local z at n1
      Vy2:  -fe[7],     // Shear local y at n2 (opposite sign convention)
      Vz2:  -fe[8],     // Shear local z at n2
      My2:  -fe[10],    // Moment about local y at n2
      Mz2:  -fe[11],    // Moment about local z at n2
      // Convenience
      Vmax:  Math.max(Math.abs(fe[1]), Math.abs(fe[7]), Math.abs(fe[2]), Math.abs(fe[8])),
      Mmax:  Math.max(Math.abs(fe[5]), Math.abs(fe[11]), Math.abs(fe[4]), Math.abs(fe[10])),
      Nabs:  Math.abs(fe[0]),
      // Local axes (for diagram rendering)
      ex, ey, ez, L,
    };
  }

  // ── Global summary ────────────────────────────────────────────────────────
  getSummary() {
    let maxU = 0, maxUNode = null;
    let maxN = 0, maxV = 0, maxM = 0;
    let maxNElem = null, maxVElem = null, maxMElem = null;

    for (const node of this.model.nodes.values()) {
      const d = this.getNodeDisp(node.id);
      const mag = Math.sqrt(d[0]**2 + d[1]**2 + d[2]**2);
      if (mag > maxU) { maxU = mag; maxUNode = node.id; }
    }

    for (const [id, f] of this._elemForces) {
      if (!f) continue;
      if (f.Nabs > maxN) { maxN = f.Nabs; maxNElem = id; }
      if (f.Vmax > maxV) { maxV = f.Vmax; maxVElem = id; }
      if (f.Mmax > maxM) { maxM = f.Mmax; maxMElem = id; }
    }

    return { maxU, maxUNode, maxN, maxNElem, maxV, maxVElem, maxM, maxMElem };
  }

  // ── Data for diagram rendering (list of {x,y} points along element) ───────
  /**
   * Returns diagram points for a given force component.
   * type: 'N'|'Vy'|'Vz'|'T'|'My'|'Mz'
   * Returns [{pos3d, val}] — position along element axis in model coordinates, and value
   */
  getDiagramData(elemId, type, nPts = 10) {
    const f = this.getElemForces(elemId);
    if (!f) return [];
    const elem = this.model.elements.get(elemId);
    const n1   = this.model.nodes.get(elem.n1);
    const n2   = this.model.nodes.get(elem.n2);
    const L    = f.L;

    // Linear variation along element (exact for uniform loads and no intermediate loads)
    const val1 = type === 'N'  ? f.N
               : type === 'Vy' ? f.Vy1
               : type === 'Vz' ? f.Vz1
               : type === 'T'  ? f.T
               : type === 'My' ? f.My1
               : /* Mz */        f.Mz1;

    const val2 = type === 'N'  ? f.N           // constant
               : type === 'Vy' ? -f.Vy2
               : type === 'Vz' ? -f.Vz2
               : type === 'T'  ? f.T
               : type === 'My' ? -f.My2
               : /* Mz */       -f.Mz2;

    const pts = [];
    for (let i=0; i<=nPts; i++) {
      const xi = i / nPts;
      const v  = val1 * (1-xi) + val2 * xi;
      // Position in model coordinates
      const pos = {
        x: n1.x + xi * (n2.x - n1.x),
        y: n1.y + xi * (n2.y - n1.y),
        z: n1.z + xi * (n2.z - n1.z)
      };
      pts.push({ pos, val: v });
    }
    return pts;
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  toCSV() {
    const lines = ['# StructWeb3D — Resultados del Análisis Estático'];
    const u = this.model.units;

    lines.push('#');
    lines.push(`# DESPLAZAMIENTOS NODALES [${u}]`);
    lines.push('# NodeID, Ux, Uy, Uz, Rx, Ry, Rz');
    for (const node of this.model.nodes.values()) {
      const d = this.getNodeDisp(node.id);
      lines.push(`${node.id}, ${d.map(v=>v.toExponential(6)).join(', ')}`);
    }

    lines.push('#');
    lines.push(`# REACCIONES [${u}]`);
    lines.push('# NodeID, Rx, Ry, Rz, Rmx, Rmy, Rmz');
    for (const node of this.model.nodes.values()) {
      const r = node.restraints;
      if (!Object.values(r).some(v=>v)) continue;
      const rx = this.getReaction(node.id);
      lines.push(`${node.id}, ${rx.map(v=>v.toExponential(6)).join(', ')}`);
    }

    lines.push('#');
    lines.push(`# FUERZAS INTERNAS EN EXTREMOS [${u}]`);
    lines.push('# ElemID, N, Vy1, Vz1, T, My1, Mz1, Vy2, Vz2, My2, Mz2');
    for (const [id, f] of this._elemForces) {
      if (!f) continue;
      lines.push([id, f.N, f.Vy1, f.Vz1, f.T, f.My1, f.Mz1, f.Vy2, f.Vz2, f.My2, f.Mz2]
        .map((v,i)=> i===0 ? v : v.toExponential(6)).join(', '));
    }

    return lines.join('\r\n');
  }
}
