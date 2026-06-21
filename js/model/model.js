// ──────────────────────────────────────────────────────────────────────────────
// Model — central data store for the structural model
// Convention: Z-up  (X east, Y north, Z vertical) — SAP2000 / ETABS style
// ──────────────────────────────────────────────────────────────────────────────

export class Model {
  constructor() {
    // Maps: id (int) → object
    this.nodes      = new Map();
    this.elements   = new Map();
    this.areas      = new Map();   // elementos de área 2D (membrana CST/QUAD)
    this.materials  = new Map();
    this.sections   = new Map();
    this.diaphragms   = new Map();
    this.loadCases    = new Map();
    this.combinations = new Map();

    this._cnt = { nodes: 0, elements: 0, areas: 0, materials: 0,
                  sections: 0, diaphragms: 0, loadCases: 0, combinations: 0 };

    this.units = 'kN-m';

    // Modo del proyecto, definido AL CREAR el modelo (Archivo → Nuevo):
    //  '3D' = estructura tridimensional.
    //  '2D' = pórtico plano X–Z: todos los nodos con Y=0, GDL fuera del plano
    //         (uy, rx, rz) restringidos automáticamente en el análisis.
    this.mode = '3D';

    // Ejes de grilla (estilo SAP/ETABS): coordenadas por dirección global.
    // x: ejes A,B,C…  y: ejes 1,2,3…  z: niveles de piso.
    this.grids = { x: [], y: [], z: [] };

    this._initDefaults();
  }

  _next(type) { return ++this._cnt[type]; }

  // ── Default material & section ─────────────────────────────────────────────
  _initDefaults() {
    this.addMaterial({ name: 'Concreto H30', E: 2.87e7, G: 1.19e7, nu: 0.2, rho: 2.5 });
    this.addSection({
      name: 'Col 30×30',
      A: 0.09, Iz: 6.75e-4, Iy: 6.75e-4, J: 1.14e-3,   // St. Venant 0.30x0.30 (0.1406 a^4); antes 1.13e-4 (10x bajo)
      Avy: 0.075, Avz: 0.075, kappay: 0.833, kappaz: 0.833
    });
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────
  addNode(x, y, z, restraints = {}) {
    const id = this._next('nodes');
    const node = {
      id,
      x: +x, y: +y, z: +z,
      restraints: { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0, ...restraints },
      nodeMass:   { mx: 0, my: 0, mz: 0 },
      // Apoyo elástico: rigidez de resorte por GDL global
      // (kux/kuy/kuz en kN/m; krx/kry/krz en kN·m/rad). 0 = sin resorte.
      springs:    { kux: 0, kuy: 0, kuz: 0, krx: 0, kry: 0, krz: 0 },
    };
    this.nodes.set(id, node);
    return node;
  }

  updateNode(id, props) {
    const n = this.nodes.get(id);
    if (!n) return null;
    if (props.x !== undefined) n.x = +props.x;
    if (props.y !== undefined) n.y = +props.y;
    if (props.z !== undefined) n.z = +props.z;
    if (props.restraints) Object.assign(n.restraints, props.restraints);
    if (props.nodeMass) {
      if (!n.nodeMass) n.nodeMass = { mx: 0, my: 0, mz: 0 };
      Object.assign(n.nodeMass, props.nodeMass);
    }
    if (props.springs) {
      if (!n.springs) n.springs = { kux: 0, kuy: 0, kuz: 0, krx: 0, kry: 0, krz: 0 };
      Object.assign(n.springs, props.springs);
    }
    return n;
  }

  removeNode(id) {
    if (!this.nodes.has(id)) return false;
    // Remove connected elements
    for (const [eid, el] of this.elements) {
      if (el.n1 === id || el.n2 === id) this.elements.delete(eid);
    }
    this.nodes.delete(id);
    return true;
  }

  // ── Elements ───────────────────────────────────────────────────────────────
  addElement(n1, n2, matId, secId) {
    if (!this.nodes.has(n1) || !this.nodes.has(n2)) return null;
    if (n1 === n2) return null;
    const id = this._next('elements');
    const elem = {
      id, n1, n2,
      matId: matId ?? this._firstKey('materials'),
      secId: secId ?? this._firstKey('sections'),
      releases: Array(12).fill(0)
    };
    this.elements.set(id, elem);
    return elem;
  }

  updateElement(id, props) {
    const el = this.elements.get(id);
    if (!el) return null;
    if (props.n1     !== undefined) el.n1     = +props.n1;
    if (props.n2     !== undefined) el.n2     = +props.n2;
    if (props.matId  !== undefined) el.matId  = +props.matId;
    if (props.secId  !== undefined) el.secId  = +props.secId;
    if (props.releases) el.releases = [...props.releases];
    // NL-lite (Fase 1): cable «tension-only» + pretensado por longitud natural.
    // L0factor = longitud natural / longitud geométrica (1 = sin pretensar, <1 = pretensado).
    if (props.cable    !== undefined) el.cable    = !!props.cable;
    if (props.L0factor !== undefined) el.L0factor = +props.L0factor || 1;
    return el;
  }

  removeElement(id) { return this.elements.delete(id); }

  // ── Elementos de área (membrana 2D: CST 3 nodos / QUAD 4 nodos) ─────────────
  addArea(nodes, matId, opts = {}) {
    const ns = (nodes || []).map(Number);
    if (ns.length !== 3 && ns.length !== 4) return null;
    if (ns.some(n => !this.nodes.has(n))) return null;
    if (new Set(ns).size !== ns.length) return null;
    const id = this._next('areas');
    const area = {
      id, nodes: ns,
      matId: matId ?? this._firstKey('materials'),
      thickness: opts.thickness ?? 0.2,
      planeStrain: !!opts.planeStrain,
      // 'membrane' (solo en-plano) | 'plate' (solo flexión) | 'shell' (membrana+placa)
      behavior: opts.behavior ?? 'membrane',
      kind: ns.length === 3 ? 'CST' : 'QUAD',
    };
    this.areas.set(id, area);
    return area;
  }

  updateArea(id, props) {
    const a = this.areas.get(id);
    if (!a) return null;
    if (props.matId      !== undefined) a.matId = +props.matId;
    if (props.thickness  !== undefined) a.thickness = +props.thickness;
    if (props.planeStrain !== undefined) a.planeStrain = !!props.planeStrain;
    if (props.behavior   !== undefined) a.behavior = props.behavior;
    if (props.nodes) { a.nodes = props.nodes.map(Number); a.kind = a.nodes.length === 3 ? 'CST' : 'QUAD'; }
    return a;
  }

  removeArea(id) { return this.areas.delete(id); }

  // ── Materials ──────────────────────────────────────────────────────────────
  addMaterial(props) {
    const id = this._next('materials');
    const mat = {
      id, name: 'Material',
      E: 2.87e7, G: 1.19e7, nu: 0.2, rho: 2.5,
      alpha: 1e-5,   // coef. de dilatación térmica [1/°C] (hormigón ~1e-5, acero ~1.2e-5)
      ...props
    };
    this.materials.set(id, mat);
    return mat;
  }

  updateMaterial(id, props) {
    const m = this.materials.get(id);
    if (!m) return null;
    Object.assign(m, props);
    if (props.E !== undefined) m.E = +props.E;
    if (props.G !== undefined) m.G = +props.G;
    if (props.nu !== undefined) m.nu = +props.nu;
    if (props.rho !== undefined) m.rho = +props.rho;
    if (props.alpha !== undefined) m.alpha = +props.alpha;
    return m;
  }

  removeMaterial(id) {
    for (const el of this.elements.values()) {
      if (el.matId === id) return { ok: false, reason: 'Material en uso por elemento(s)' };
    }
    this.materials.delete(id);
    return { ok: true };
  }

  // ── Sections ───────────────────────────────────────────────────────────────
  addSection(props) {
    const id = this._next('sections');
    const sec = {
      id, name: 'Sección',
      A: 0.09, Iz: 6.75e-4, Iy: 6.75e-4, J: 1.14e-3,   // St. Venant 0.30x0.30 (0.1406 a^4); antes 1.13e-4 (10x bajo)
      Avy: 0.075, Avz: 0.075, kappay: 0.833, kappaz: 0.833,
      mod: { A: 1, Iy: 1, Iz: 1, J: 1 },   // modificadores de rigidez (sección agrietada, etc.)
      ...props
    };
    if (!sec.mod) sec.mod = { A: 1, Iy: 1, Iz: 1, J: 1 };
    this.sections.set(id, sec);
    return sec;
  }

  updateSection(id, props) {
    const s = this.sections.get(id);
    if (!s) return null;
    if (props.mod) { s.mod = { ...(s.mod || { A:1, Iy:1, Iz:1, J:1 }), ...props.mod }; delete props.mod; }
    Object.assign(s, props);
    const nums = ['A','Iz','Iy','J','Avy','Avz','kappay','kappaz'];
    nums.forEach(k => { if (props[k] !== undefined) s[k] = +props[k]; });
    if (!s.mod) s.mod = { A:1, Iy:1, Iz:1, J:1 };
    return s;
  }

  removeSection(id) {
    for (const el of this.elements.values()) {
      if (el.secId === id) return { ok: false, reason: 'Sección en uso por elemento(s)' };
    }
    this.sections.delete(id);
    return { ok: true };
  }

  // ── Diaphragms ─────────────────────────────────────────────────────────────
  addDiaphragm(props) {
    const id = this._next('diaphragms');
    const d = {
      id, z: 0, nodes: [],
      cm: { x: 0, y: 0 },
      mass: { m: 0, Icm: 0 },
      eccentricity: { ex: 0, ey: 0 },
      ...props
    };
    this.diaphragms.set(id, d);
    return d;
  }

  removeDiaphragm(id) { return this.diaphragms.delete(id); }

  // ── Load Cases ─────────────────────────────────────────────────────────────
  // selfWeight: si true, el análisis de este caso incluye el peso propio de
  // todos los elementos (típico del caso CM / carga muerta).
  // type: 'static' (cargas asignadas, F5) o 'spectrum' (sísmico por espectro de
  // respuesta, F7). Un caso espectral no admite cargas; specDir = 'X' | 'Y'.
  addLoadCase(name, selfWeight = false, type = 'static', specDir = null) {
    const id = this._next('loadCases');
    const lc = {
      id, name: name || `LC${id}`, loads: [],
      selfWeight: !!selfWeight,
      type: type === 'spectrum' ? 'spectrum' : 'static',
      specDir: type === 'spectrum' ? (specDir || 'X') : null,
    };
    this.loadCases.set(id, lc);
    return lc;
  }

  // ── Load Combinations ──────────────────────────────────────────────────────
  addCombination(props) {
    const id = this._next('combinations');
    const combo = { id, name: `Combo ${id}`, factors: [], ...props };
    this.combinations.set(id, combo);
    return combo;
  }

  updateCombination(id, props) {
    const c = this.combinations.get(id);
    if (!c) return null;
    Object.assign(c, props);
    return c;
  }

  removeCombination(id) { return this.combinations.delete(id); }

  addLoad(caseId, load) {
    const lc = this.loadCases.get(caseId);
    if (!lc) return null;
    lc.loads.push(load);
    return load;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  _firstKey(mapName) {
    return this[mapName].keys().next().value ?? null;
  }

  getStats() {
    return {
      nodes:      this.nodes.size,
      elements:   this.elements.size,
      materials:  this.materials.size,
      sections:   this.sections.size,
      diaphragms: this.diaphragms.size
    };
  }

  // Bounding box of all nodes {min:{x,y,z}, max:{x,y,z}, center:{x,y,z}}
  getBounds() {
    if (this.nodes.size === 0) {
      return { min:{x:0,y:0,z:0}, max:{x:10,y:10,z:10}, center:{x:5,y:5,z:5} };
    }
    let xMin=Infinity, yMin=Infinity, zMin=Infinity;
    let xMax=-Infinity, yMax=-Infinity, zMax=-Infinity;
    for (const n of this.nodes.values()) {
      if (n.x < xMin) xMin = n.x; if (n.x > xMax) xMax = n.x;
      if (n.y < yMin) yMin = n.y; if (n.y > yMax) yMax = n.y;
      if (n.z < zMin) zMin = n.z; if (n.z > zMax) zMax = n.z;
    }
    return {
      min: {x:xMin, y:yMin, z:zMin},
      max: {x:xMax, y:yMax, z:zMax},
      center: {x:(xMin+xMax)/2, y:(yMin+yMax)/2, z:(zMin+zMax)/2}
    };
  }

  // Reset data but keep materials and sections
  clear() {
    this.nodes.clear();
    this.elements.clear();
    this.diaphragms.clear();
    this.loadCases.clear();
    this.combinations.clear();
    this._cnt.nodes = 0;
    this._cnt.elements = 0;
    this._cnt.diaphragms = 0;
    this._cnt.loadCases = 0;
    this._cnt.combinations = 0;
  }

  // Full reset including materials and sections
  reset() {
    this.clear();
    this.materials.clear();
    this.sections.clear();
    this._cnt.materials = 0;
    this._cnt.sections = 0;
    this._initDefaults();
  }
}
