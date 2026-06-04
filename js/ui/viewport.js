// ──────────────────────────────────────────────────────────────────────────────
// Viewport — Three.js 3D scene, interaction, rendering
// Coordinate convention:
//   Model:     X east, Y north, Z up  (SAP2000 / ETABS)
//   Three.js:  X east, Y up,  Z south (Y-up default)
//   Transform: m2t(x,y,z) → (x, z, y)   t2m(v) → {x:v.x, y:v.z, z:v.y}
// ──────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const COL = {
  BG:          0x0a0e1a,
  GRID_MAIN:   0x334,
  GRID_CENTER: 0x445577,
  NODE:        0x4fc3f7,
  NODE_HOVER:  0xff9800,
  NODE_SEL:    0xffc107,
  NODE_FIXED:  0xef5350,
  NODE_PIN:    0xff7043,
  ELEM:        0x607d8b,
  ELEM_HOVER:  0xff9800,
  ELEM_SEL:    0xffc107,
  PREVIEW:     0x64b5f6,
  AXIS_X:      0xff4444,
  AXIS_Y:      0x44cc44,
  AXIS_Z:      0x4488ff,
};
const NODE_R      = 0.12;
const NODE_SEG    = 8;
const SNAP_PX     = 22;   // screen-space snap radius in pixels

export class Viewport {
  constructor(container, app) {
    this.container = container;
    this.app = app;
    this.mode = 'select';

    this._renderer = null;
    this._scene    = null;
    this._camera   = null;
    this._controls = null;

    this._nodeMeshes  = new Map();  // nodeId  → THREE.Mesh
    this._elemLines   = new Map();  // elemId  → THREE.Line
    this._suppGroups  = new Map();  // nodeId  → THREE.Group
    this._diaGroups   = new Map();  // diaphragmId → THREE.Group

    this._selected = new Set();     // 'node:id' | 'elem:id'
    this._hovered  = null;          // {type, id} | null

    this._addElemFirst = null;      // nodeId of first endpoint
    this._previewSphere = null;
    this._previewLine   = null;
    this._floorZ   = 0;
    this._snapSize = 0.5;

    this._mouse       = new THREE.Vector2(-999, -999);
    this._raycaster   = new THREE.Raycaster();
    this._raycaster.params.Line  = { threshold: 0.18 };
    this._raycaster.params.Points = { threshold: 0.18 };

    this._ptrDownPos  = null;       // for distinguishing click vs drag
    this._grid        = null;
    this._axesGroup   = null;

    // Mode shape animation state
    this._animFn         = null;    // callback called each frame (null = no animation)
    this._animT          = 0;
    this._animMeshNodes  = [];      // [{mesh, pbase, dp}]
    this._animLineElems  = [];      // [{geo, p1base, p2base, dp1, dp2}]

    // Load visualization
    this._loadObjects = [];         // THREE objects for load arrows

    this._init();
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────
  m2t(x, y, z) { return new THREE.Vector3(x, z, y); }
  t2m(v)       { return { x: v.x, y: v.z, z: v.y }; }

  // ── Initialization ─────────────────────────────────────────────────────────
  _init() {
    // Renderer
    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setClearColor(COL.BG, 1);
    this.container.appendChild(this._renderer.domElement);

    // Camera
    this._camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
    this._camera.position.set(12, 10, 12);
    this._camera.lookAt(0, 0, 0);

    // Scene
    this._scene = new THREE.Scene();
    this._scene.add(new THREE.AmbientLight(0xffffff, 1));

    // Controls
    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping  = true;
    this._controls.dampingFactor  = 0.08;
    this._controls.screenSpacePanning = true;
    this._controls.zoomSpeed      = 1.2;
    this._controls.mouseButtons   = { LEFT: THREE.MOUSE.LEFT, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

    // Grid (Three.js XZ plane = model XY floor)
    this._buildGrid();

    // Axis arrows
    this._buildAxes();

    // Invisible floor plane for raycasting
    this._floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1e6, 1e6),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
    );
    this._floorMesh.rotation.x = -Math.PI / 2;
    this._scene.add(this._floorMesh);

    // Preview objects
    this._buildPreview();

    // Bind events
    const el = this._renderer.domElement;
    el.addEventListener('pointermove', e => this._onMove(e));
    el.addEventListener('pointerdown', e => this._onDown(e));
    el.addEventListener('pointerup',   e => this._onUp(e));
    el.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize',  () => this._onResize());
    this._onResize();

    // Floor-Z and snap inputs
    document.getElementById('floor-z').addEventListener('input', e => {
      this._floorZ = parseFloat(e.target.value) || 0;
      this._floorMesh.position.y = this._floorZ;
      if (this._grid) this._grid.position.y = this._floorZ;
    });
    document.getElementById('snap-size').addEventListener('input', e => {
      this._snapSize = Math.max(0, parseFloat(e.target.value) || 0);
    });

    // Escape cancels addelem
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (this._addElemFirst !== null) {
          this._refreshColor('node', this._addElemFirst);
          this._addElemFirst = null;
          this._previewLine.visible = false;
          document.getElementById('sb-sel').textContent = 'Sin selección';
        }
      }
    });

    this._animate();
  }

  _buildGrid() {
    this._grid = new THREE.Group();
    const main = new THREE.GridHelper(200, 200, COL.GRID_CENTER, COL.GRID_MAIN);
    main.material.transparent = true;
    main.material.opacity = 0.7;
    this._grid.add(main);
    this._scene.add(this._grid);
  }

  _buildAxes() {
    this._axesGroup = new THREE.Group();
    const len = 2.5, hw = 0.5, hr = 0.15;

    const arrow = (dir3, color) => {
      const a = new THREE.ArrowHelper(dir3, new THREE.Vector3(0,0,0), len, color, hw, hr);
      this._axesGroup.add(a);
    };
    // Model X → Three.js +X
    arrow(new THREE.Vector3(1, 0, 0), COL.AXIS_X);
    // Model Y → Three.js +Z
    arrow(new THREE.Vector3(0, 0, 1), COL.AXIS_Y);
    // Model Z (up) → Three.js +Y
    arrow(new THREE.Vector3(0, 1, 0), COL.AXIS_Z);

    this._scene.add(this._axesGroup);
  }

  _buildPreview() {
    // Ghost sphere (addnode / addelem)
    this._previewSphere = new THREE.Mesh(
      new THREE.SphereGeometry(NODE_R * 1.3, NODE_SEG, NODE_SEG),
      new THREE.MeshBasicMaterial({ color: COL.PREVIEW, transparent: true, opacity: 0.55, depthTest: false })
    );
    this._previewSphere.visible = false;
    this._scene.add(this._previewSphere);

    // Ghost line (addelem after first node)
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this._previewLine = new THREE.Line(geo,
      new THREE.LineBasicMaterial({ color: COL.PREVIEW, transparent: true, opacity: 0.5, depthTest: false })
    );
    this._previewLine.visible = false;
    this._scene.add(this._previewLine);
  }

  // ── Render loop ────────────────────────────────────────────────────────────
  _animate() {
    requestAnimationFrame(() => this._animate());
    if (this._animFn) this._animFn();
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  }

  _onResize() {
    const w = this.container.clientWidth  || 800;
    const h = this.container.clientHeight || 600;
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  // ── Model rendering ────────────────────────────────────────────────────────
  renderModel(model) {
    // Clear all model objects
    for (const m of this._nodeMeshes.values()) this._scene.remove(m);
    for (const l of this._elemLines.values())  this._scene.remove(l);
    for (const g of this._suppGroups.values())  this._scene.remove(g);
    this._nodeMeshes.clear();
    this._elemLines.clear();
    this._suppGroups.clear();
    this._selected.clear();
    this._hovered = null;
    this._addElemFirst = null;
    this._previewLine.visible   = false;
    this._previewSphere.visible = false;

    for (const n of model.nodes.values())    this.addNodeMesh(n);
    for (const e of model.elements.values()) this.addElemLine(e);
    this.refreshDiaphragms();
  }

  addNodeMesh(node) {
    if (this._nodeMeshes.has(node.id)) {
      this._scene.remove(this._nodeMeshes.get(node.id));
    }
    const geo  = new THREE.SphereGeometry(NODE_R, NODE_SEG, NODE_SEG);
    const mat  = new THREE.MeshBasicMaterial({ color: this._nodeColor(node) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(this.m2t(node.x, node.y, node.z));
    mesh.userData = { type: 'node', id: node.id };
    this._scene.add(mesh);
    this._nodeMeshes.set(node.id, mesh);

    // Support symbol
    if (this._hasAnyRestraint(node)) this._buildSuppSymbol(node);
    else {
      const g = this._suppGroups.get(node.id);
      if (g) { this._scene.remove(g); this._suppGroups.delete(node.id); }
    }
  }

  removeNodeMesh(nodeId) {
    const m = this._nodeMeshes.get(nodeId);
    if (m) { this._scene.remove(m); this._nodeMeshes.delete(nodeId); }
    const g = this._suppGroups.get(nodeId);
    if (g) { this._scene.remove(g); this._suppGroups.delete(nodeId); }
    // Also remove element lines connected to this node
    for (const [eid, line] of this._elemLines) {
      if (line.userData.n1 === nodeId || line.userData.n2 === nodeId) {
        this._scene.remove(line);
        this._elemLines.delete(eid);
      }
    }
    this._selected.delete(`node:${nodeId}`);
  }

  addElemLine(elem) {
    if (this._elemLines.has(elem.id)) this._scene.remove(this._elemLines.get(elem.id));
    const n1 = this.app.model.nodes.get(elem.n1);
    const n2 = this.app.model.nodes.get(elem.n2);
    if (!n1 || !n2) return;

    const geo  = new THREE.BufferGeometry().setFromPoints([
      this.m2t(n1.x, n1.y, n1.z), this.m2t(n2.x, n2.y, n2.z)
    ]);
    const mat  = new THREE.LineBasicMaterial({ color: COL.ELEM });
    const line = new THREE.Line(geo, mat);
    line.userData = { type: 'elem', id: elem.id, n1: elem.n1, n2: elem.n2 };
    this._scene.add(line);
    this._elemLines.set(elem.id, line);
  }

  removeElemLine(elemId) {
    const l = this._elemLines.get(elemId);
    if (l) { this._scene.remove(l); this._elemLines.delete(elemId); }
    this._selected.delete(`elem:${elemId}`);
  }

  refreshNode(node) {
    // Update after property edit (position or restraints changed)
    this.addNodeMesh(node);
    // Re-colour any connected element endpoints
    for (const [eid, line] of this._elemLines) {
      if (line.userData.n1 === node.id || line.userData.n2 === node.id) {
        const elem = this.app.model.elements.get(eid);
        if (elem) this.addElemLine(elem);
      }
    }
    // Restore selection highlight if still selected
    if (this._selected.has(`node:${node.id}`)) {
      const mesh = this._nodeMeshes.get(node.id);
      if (mesh) mesh.material.color.set(COL.NODE_SEL);
    }
  }

  refreshElem(elem) {
    this.addElemLine(elem);
    if (this._selected.has(`elem:${elem.id}`)) {
      const line = this._elemLines.get(elem.id);
      if (line) line.material.color.set(COL.ELEM_SEL);
    }
  }

  // ── Support symbol ─────────────────────────────────────────────────────────
  _buildSuppSymbol(node) {
    const existing = this._suppGroups.get(node.id);
    if (existing) this._scene.remove(existing);

    const grp = new THREE.Group();
    const r = node.restraints;
    const transCount = (r.ux ? 1 : 0) + (r.uy ? 1 : 0) + (r.uz ? 1 : 0);
    const rotCount   = (r.rx ? 1 : 0) + (r.ry ? 1 : 0) + (r.rz ? 1 : 0);
    const allFixed   = transCount === 3 && rotCount === 3;
    const transFixed = transCount === 3;
    const rollerOnly = transCount > 0 && !transFixed;

    const s = 0.28;
    const ln = (pts, col, op = 1) => {
      const m = new THREE.LineBasicMaterial({ color: col });
      if (op < 1) { m.transparent = true; m.opacity = op; }
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), m));
    };

    if (allFixed) {
      // ── Empotrado: filled box + triangle — RED ─────────────────────────────
      const col = COL.NODE_FIXED;
      // Triangle
      ln([new THREE.Vector3(0,0,0), new THREE.Vector3(-s,0,-s*1.5),
          new THREE.Vector3(s,0,-s*1.5), new THREE.Vector3(0,0,0)], col);
      // Box below triangle
      const bx = s * 1.1, bz1 = -s * 1.5, bz2 = -s * 2.2;
      ln([new THREE.Vector3(-bx,0,bz1), new THREE.Vector3(bx,0,bz1),
          new THREE.Vector3(bx,0,bz2), new THREE.Vector3(-bx,0,bz2),
          new THREE.Vector3(-bx,0,bz1)], col);
      // Diagonal fill inside box
      ln([new THREE.Vector3(-bx,0,bz1), new THREE.Vector3(bx,0,bz2)], col, 0.5);
      ln([new THREE.Vector3(bx,0,bz1), new THREE.Vector3(-bx,0,bz2)], col, 0.5);

    } else if (transFixed) {
      // ── Pin/Articulado: triangle + hatch — ORANGE ──────────────────────────
      const col = COL.NODE_PIN;
      ln([new THREE.Vector3(0,0,0), new THREE.Vector3(-s,0,-s*1.6),
          new THREE.Vector3(s,0,-s*1.6), new THREE.Vector3(0,0,0)], col);
      ln([new THREE.Vector3(-s*1.1,0,-s*1.6), new THREE.Vector3(s*1.1,0,-s*1.6)], col);
      for (let i = 0; i < 4; i++) {
        const x0 = -s*0.9 + i*s*0.6;
        ln([new THREE.Vector3(x0,0,-s*1.6), new THREE.Vector3(x0-s*0.3,0,-s*2.0)], col, 0.6);
      }

    } else if (rollerOnly) {
      // ── Roller: small triangle + wheel circles — CYAN ──────────────────────
      const col = 0x00bcd4;
      const sr = s * 0.65;
      ln([new THREE.Vector3(0,0,0), new THREE.Vector3(-sr,0,-sr*1.4),
          new THREE.Vector3(sr,0,-sr*1.4), new THREE.Vector3(0,0,0)], col);
      // Two circles (8-point polygons) as wheels
      const rr = sr * 0.38, cz = -sr * 1.4 - rr;
      for (const cx of [-sr * 0.55, sr * 0.55]) {
        const pts = [];
        for (let k = 0; k <= 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          pts.push(new THREE.Vector3(cx + rr * Math.cos(a), 0, cz + rr * Math.sin(a)));
        }
        ln(pts, col);
      }

    } else {
      // ── Partial / rotational only: small cross — YELLOW ───────────────────
      const col = 0xd29922;
      const c = 0.18;
      ln([new THREE.Vector3(-c,0,0), new THREE.Vector3(c,0,0)], col);
      ln([new THREE.Vector3(0,0,-c), new THREE.Vector3(0,0,c)], col);
      ln([new THREE.Vector3(-c,0,-c), new THREE.Vector3(c,0,c)], col, 0.5);
      ln([new THREE.Vector3(c,0,-c), new THREE.Vector3(-c,0,c)], col, 0.5);
    }

    grp.position.copy(this.m2t(node.x, node.y, node.z));
    grp.userData = { type: 'support', nodeId: node.id };
    this._scene.add(grp);
    this._suppGroups.set(node.id, grp);
  }

  // ── Pointer helpers ────────────────────────────────────────────────────────
  _ndc(e) {
    const r = this._renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
       (e.clientX - r.left) / r.width  * 2 - 1,
      -(e.clientY - r.top)  / r.height * 2 + 1
    );
  }

  _floorPoint() {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this._floorZ);
    const pt = new THREE.Vector3();
    this._raycaster.ray.intersectPlane(plane, pt);
    if (!pt || isNaN(pt.x)) return null;
    if (this._snapSize > 0) {
      pt.x = Math.round(pt.x / this._snapSize) * this._snapSize;
      pt.z = Math.round(pt.z / this._snapSize) * this._snapSize;
    }
    return pt;
  }

  // Find nearest node within SNAP_PX screen pixels; returns {id} or null
  _nearestNodeSnap() {
    const el   = this._renderer.domElement;
    const W = el.clientWidth, H = el.clientHeight;
    const mx = (this._mouse.x + 1) / 2 * W;
    const my = (1 - (this._mouse.y + 1) / 2) * H;
    let best = null, bestDist = SNAP_PX;

    for (const [id, mesh] of this._nodeMeshes) {
      const p = mesh.position.clone().project(this._camera);
      const sx = (p.x + 1) / 2 * W;
      const sy = (1 - (p.y + 1) / 2) * H;
      const d  = Math.hypot(sx - mx, sy - my);
      if (d < bestDist) { bestDist = d; best = { id }; }
    }
    return best;
  }

  // ── Pointer events ─────────────────────────────────────────────────────────
  _onMove(e) {
    if (e.buttons & 2 || e.buttons & 4) return;
    this._mouse.copy(this._ndc(e));
    this._raycaster.setFromCamera(this._mouse, this._camera);

    // Update coord display
    const fp = this._floorPoint();
    if (fp) {
      const mc = this.t2m(fp);
      document.getElementById('sb-coords').textContent =
        `X: ${mc.x.toFixed(3)}  Y: ${mc.y.toFixed(3)}  Z: ${mc.z.toFixed(3)}`;
    }

    switch (this.mode) {
      case 'select':     this._hoverUpdate(); break;
      case 'addnode':    this._previewAddNode(fp); break;
      case 'addelem':    this._previewAddElem(fp); break;
      case 'addsupport': this._hoverUpdate(); break;
    }
  }

  _onDown(e) {
    if (e.button !== 0) return;
    this._ptrDownPos = [e.clientX, e.clientY];
  }

  _onUp(e) {
    if (e.button !== 0 || !this._ptrDownPos) return;
    const dx = e.clientX - this._ptrDownPos[0];
    const dy = e.clientY - this._ptrDownPos[1];
    this._ptrDownPos = null;
    if (Math.hypot(dx, dy) > 6) return; // was a drag

    this._mouse.copy(this._ndc(e));
    this._raycaster.setFromCamera(this._mouse, this._camera);

    switch (this.mode) {
      case 'select':     this._clickSelect(e.ctrlKey || e.metaKey); break;
      case 'addnode':    this._clickAddNode();     break;
      case 'addelem':    this._clickAddElem();     break;
      case 'addsupport': this._clickAddSupport();  break;
    }
  }

  // ── Select mode ────────────────────────────────────────────────────────────
  _hoverUpdate() {
    const prev = this._hovered;
    const nodeHits = this._raycaster.intersectObjects([...this._nodeMeshes.values()]);
    const elemHits = this._raycaster.intersectObjects([...this._elemLines.values()]);
    const diaPlanes = [...this._diaGroups.values()]
      .map(g => g.children.find(c => c.userData.type === 'diaphragm')).filter(Boolean);
    const cmSpheres = [...this._diaGroups.values()]
      .map(g => g.children.find(c => c.userData.type === 'cm-sphere')).filter(Boolean);
    const diaHits  = this._raycaster.intersectObjects(diaPlanes);
    const cmHits   = this._raycaster.intersectObjects(cmSpheres);

    let next = null;
    if (nodeHits.length)      next = { type: 'node',      id: nodeHits[0].object.userData.id };
    else if (elemHits.length) next = { type: 'elem',      id: elemHits[0].object.userData.id };
    else if (cmHits.length)   next = { type: 'cm-sphere', id: cmHits[0].object.userData.diaId };
    else if (diaHits.length)  next = { type: 'diaphragm', id: diaHits[0].object.userData.id };

    if (prev && (!next || prev.type !== next.type || prev.id !== next.id)) {
      if (prev.type !== 'diaphragm' && !this._selected.has(`${prev.type}:${prev.id}`))
        this._refreshColor(prev.type, prev.id);
      if (prev.type === 'diaphragm') this._setDiaHighlight(prev.id, false);
    }
    if (next && (!prev || prev.type !== next.type || prev.id !== next.id)) {
      if (next.type === 'diaphragm') this._setDiaHighlight(next.id, true);
      else if (!this._selected.has(`${next.type}:${next.id}`))
        this._setColor(next.type, next.id, COL.NODE_HOVER, COL.ELEM_HOVER);
    }
    this._hovered = next;
    this._renderer.domElement.style.cursor = next ? 'pointer' : 'default';
  }

  _clickSelect(ctrlHeld = false) {
    const nodeHits = this._raycaster.intersectObjects([...this._nodeMeshes.values()]);
    const elemHits = this._raycaster.intersectObjects([...this._elemLines.values()]);
    const diaPlanes = [...this._diaGroups.values()]
      .map(g => g.children.find(c => c.userData.type === 'diaphragm')).filter(Boolean);
    const cmSpheres = [...this._diaGroups.values()]
      .map(g => g.children.find(c => c.userData.type === 'cm-sphere')).filter(Boolean);
    const diaHits  = this._raycaster.intersectObjects(diaPlanes);
    const cmHits   = this._raycaster.intersectObjects(cmSpheres);

    if (nodeHits.length) {
      const id = nodeHits[0].object.userData.id;
      if (ctrlHeld) {
        this._toggleMulti('node', id);
        this._notifyMultiSelection();
      } else {
        this._selectSingle('node', id);
      }
    } else if (elemHits.length) {
      const id = elemHits[0].object.userData.id;
      if (ctrlHeld) {
        this._toggleMulti('elem', id);
        this._notifyMultiSelection();
      } else {
        this._selectSingle('elem', id);
      }
    } else if (cmHits.length) {
      // CM sphere clicked → show diaphragm + CM displacements
      const dId = cmHits[0].object.userData.diaId;
      this.clearSelection();
      this._selected.add(`diaphragm:${dId}`);
      this._setDiaHighlight(dId, true);
      document.getElementById('sb-sel').textContent = `CM Diafragma #${dId}`;
      this.app.panel.showDiaphragm(dId, true);
    } else if (diaHits.length) {
      const dId = diaHits[0].object.userData.id;
      this.clearSelection();
      this._selected.add(`diaphragm:${dId}`);
      this._setDiaHighlight(dId, true);
      document.getElementById('sb-sel').textContent = `Diafragma #${dId} seleccionado`;
      this.app.panel.showDiaphragm(dId);
    } else {
      this.clearSelection();
      this.app.panel.showNothing();
    }
  }

  _toggleMulti(type, id) {
    const key = `${type}:${id}`;
    if (this._selected.has(key)) {
      this._selected.delete(key);
      this._refreshColor(type, id);
    } else {
      this._selected.add(key);
      this._setColor(type, id, COL.NODE_SEL, COL.ELEM_SEL);
    }
    const count = this._selected.size;
    document.getElementById('sb-sel').textContent =
      count === 0 ? 'Sin selección' : `${count} objeto(s) seleccionado(s)  [Ctrl+clic para añadir]`;
  }

  _notifyMultiSelection() {
    const items = this.getSelected();
    if (items.length === 0) { this.app.panel.showNothing(); return; }
    if (items.length === 1) {
      const { type, id } = items[0];
      if (type === 'node') this.app.panel.showNode(this.app.model.nodes.get(id));
      else                 this.app.panel.showElement(this.app.model.elements.get(id));
    } else {
      this.app.panel.showSelection(items);
    }
  }

  _setDiaHighlight(dId, on) {
    const grp = this._diaGroups.get(dId);
    if (!grp) return;
    const plane = grp.children.find(c => c.userData.type === 'diaphragm');
    if (plane) plane.material.opacity = on ? 0.18 : 0.06;
  }

  _selectSingle(type, id) {
    this.clearSelection();
    this._selected.add(`${type}:${id}`);
    this._setColor(type, id, COL.NODE_SEL, COL.ELEM_SEL);
    const lbl = type === 'node' ? `Nodo #${id}` : `Elemento #${id}`;
    document.getElementById('sb-sel').textContent = `${lbl} seleccionado`;
    if (type === 'node') this.app.panel.showNode(this.app.model.nodes.get(id));
    else                 this.app.panel.showElement(this.app.model.elements.get(id));
  }

  clearSelection() {
    for (const key of this._selected) {
      const [t, sid] = key.split(':');
      if (t === 'diaphragm') this._setDiaHighlight(+sid, false);
      else this._refreshColor(t, +sid);
    }
    this._selected.clear();
    document.getElementById('sb-sel').textContent = 'Sin selección';
  }

  getSelected() {
    return [...this._selected].map(k => {
      const [type, id] = k.split(':');
      return { type, id: +id };
    });
  }

  selectAll() {
    for (const id of this._nodeMeshes.keys()) {
      this._selected.add(`node:${id}`);
      this._nodeMeshes.get(id).material.color.set(COL.NODE_SEL);
    }
    for (const id of this._elemLines.keys()) {
      this._selected.add(`elem:${id}`);
      this._elemLines.get(id).material.color.set(COL.ELEM_SEL);
    }
  }

  // ── Add Node mode ──────────────────────────────────────────────────────────
  _previewAddNode(fp) {
    this._renderer.domElement.style.cursor = 'crosshair';
    if (fp) {
      this._previewSphere.position.copy(fp);
      this._previewSphere.visible = true;
    } else {
      this._previewSphere.visible = false;
    }
  }

  _clickAddNode() {
    const fp = this._floorPoint();
    if (!fp) return;
    const mc = this.t2m(fp);
    this.app.addNode(mc.x, mc.y, mc.z);
  }

  // ── Add Element mode ───────────────────────────────────────────────────────
  _previewAddElem(fp) {
    this._renderer.domElement.style.cursor = 'crosshair';
    const snap = this._nearestNodeSnap();
    const snapPos = snap ? this._nodeMeshes.get(snap.id).position : fp;

    if (snapPos) {
      this._previewSphere.position.copy(snapPos);
      this._previewSphere.visible = true;
    }

    if (this._addElemFirst !== null) {
      const p1 = this._nodeMeshes.get(this._addElemFirst)?.position;
      if (p1 && snapPos) {
        this._previewLine.geometry.setFromPoints([p1, snapPos]);
        this._previewLine.geometry.needsUpdate = true;
        this._previewLine.visible = true;
      }
    }
  }

  _clickAddElem() {
    const snap = this._nearestNodeSnap();
    if (!snap) {
      this.app.toast('Haga clic sobre un nodo existente', 'warn');
      return;
    }
    if (this._addElemFirst === null) {
      this._addElemFirst = snap.id;
      this._setColor('node', snap.id, COL.NODE_SEL, null);
      document.getElementById('sb-sel').textContent = `Nodo #${snap.id} → clic en nodo destino`;
    } else {
      const n1 = this._addElemFirst, n2 = snap.id;
      this._refreshColor('node', n1);
      this._addElemFirst = null;
      this._previewLine.visible = false;
      if (n1 === n2) { this.app.toast('Los nodos deben ser distintos', 'warn'); return; }
      this.app.addElement(n1, n2);
    }
  }

  // ── Add Support mode ───────────────────────────────────────────────────────
  _clickAddSupport() {
    const hits = this._raycaster.intersectObjects([...this._nodeMeshes.values()]);
    if (!hits.length) return;
    const id = hits[0].object.userData.id;
    this._selectSingle('node', id);
    this.app.panel.showNode(this.app.model.nodes.get(id), true);
    // Switch to panel tab sel
    document.querySelector('.ptab[data-tab="sel"]').click();
  }

  // ── Color helpers ──────────────────────────────────────────────────────────
  _setColor(type, id, nc, ec) {
    if (type === 'node') {
      const m = this._nodeMeshes.get(id);
      if (m && nc != null) m.material.color.set(nc);
    } else {
      const l = this._elemLines.get(id);
      if (l && ec != null) l.material.color.set(ec);
    }
  }

  _refreshColor(type, id) {
    if (type === 'node') {
      const node = this.app.model.nodes.get(id);
      if (node) this._setColor('node', id, this._nodeColor(node), null);
    } else {
      this._setColor('elem', id, null, COL.ELEM);
    }
  }

  _nodeColor(node) {
    const r = node.restraints;
    if (r.ux && r.uy && r.uz && r.rx && r.ry && r.rz) return COL.NODE_FIXED;
    if (r.ux || r.uy || r.uz || r.rx || r.ry || r.rz)  return COL.NODE_PIN;
    return COL.NODE;
  }

  _hasAnyRestraint(node) {
    const r = node.restraints;
    return r.ux || r.uy || r.uz || r.rx || r.ry || r.rz;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  setMode(mode) {
    this.mode = mode;
    if (mode !== 'addelem' && this._addElemFirst !== null) {
      this._refreshColor('node', this._addElemFirst);
      this._addElemFirst = null;
      this._previewLine.visible = false;
    }
    if (mode !== 'addnode' && mode !== 'addelem') {
      this._previewSphere.visible = false;
    }
    // Toolbar highlight
    document.querySelectorAll('.tool[data-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === mode)
    );
    // Status bar mode
    const names = {
      select:     'Seleccionar',
      addnode:    'Agregar Nodo',
      addelem:    'Agregar Elemento',
      addsupport: 'Asignar Apoyo'
    };
    document.getElementById('sb-mode').textContent = `Modo: ${names[mode] || mode}`;
    // Hint overlay
    const hints = {
      addnode:    'Clic en la grilla para crear nodo',
      addelem:    'Clic en nodo origen → nodo destino  |  Esc para cancelar',
      addsupport: 'Clic en un nodo para editar sus restricciones'
    };
    const el = document.getElementById('vp-hint');
    el.textContent = hints[mode] || '';
    el.classList.toggle('visible', !!hints[mode]);
    // Cursor
    const cur = (mode === 'addnode' || mode === 'addelem') ? 'crosshair' : 'default';
    this._renderer.domElement.style.cursor = cur;
  }

  setView(view) {
    const b = this.app.model.getBounds();
    // Centre in Three.js coords (m2t of model center)
    const tc = this.m2t(b.center.x, b.center.y, b.center.z);
    const span = Math.max(
      b.max.x - b.min.x,
      b.max.y - b.min.y,
      b.max.z - b.min.z,
      10
    );
    const d = span * 1.8;
    this._controls.target.copy(tc);

    const positions = {
      iso:   [tc.x + d*0.7, tc.y + d*0.6, tc.z + d*0.7],
      top:   [tc.x,         tc.y + d*1.5,  tc.z],
      front: [tc.x,         tc.y,           tc.z + d],
      side:  [tc.x + d,     tc.y,           tc.z]
    };
    const p = positions[view] || positions.iso;
    this._camera.position.set(...p);
    this._camera.lookAt(tc);
    this._controls.update();
  }

  zoomExtents() { this.setView('iso'); }
  toggleGrid()  { this._grid.visible = !this._grid.visible; }
  toggleAxes()  { this._axesGroup.visible = !this._axesGroup.visible; }

  // ── Diaphragm visualization ────────────────────────────────────────────────
  refreshDiaphragms() {
    // Remove old
    for (const grp of this._diaGroups.values()) this._scene.remove(grp);
    this._diaGroups.clear();
    // Build new
    for (const d of this.app.model.diaphragms.values()) {
      const grp = this._buildDiaphragmViz(d);
      if (grp) {
        this._scene.add(grp);
        this._diaGroups.set(d.id, grp);
      }
    }
  }

  _buildDiaphragmViz(d) {
    const nodes = d.nodes
      .map(id => this.app.model.nodes.get(id))
      .filter(Boolean);
    if (nodes.length < 2) return null;

    const grp = new THREE.Group();
    const DIA_COL = 0x00bcd4;  // cyan
    const CM_COL  = 0xff7043;  // orange-red

    // Bounding box of floor nodes
    let xMin=Infinity, xMax=-Infinity, yMin=Infinity, yMax=-Infinity;
    for (const n of nodes) {
      if (n.x < xMin) xMin = n.x; if (n.x > xMax) xMax = n.x;
      if (n.y < yMin) yMin = n.y; if (n.y > yMax) yMax = n.y;
    }
    const pad = 0.3;
    const cx = (xMin+xMax)/2, cy = (yMin+yMax)/2;
    const w = xMax - xMin + pad*2, h = yMax - yMin + pad*2;

    // Semi-transparent floor plane (also serves as click target)
    const planeMat = new THREE.MeshBasicMaterial({
      color: DIA_COL, transparent: true, opacity: 0.06,
      side: THREE.DoubleSide, depthWrite: false
    });
    const planeGeo = new THREE.PlaneGeometry(w, h);
    const plane = new THREE.Mesh(planeGeo, planeMat);
    // In Three.js Y-up, floor plane is rotated: model(cx,cy,z) → three(cx,z,cy)
    plane.position.set(cx, d.z, cy);
    plane.rotation.x = -Math.PI / 2;
    plane.userData = { type: 'diaphragm', id: d.id };
    grp.add(plane);

    // Outline rectangle
    const corners = [
      this.m2t(xMin-pad, yMin-pad, d.z),
      this.m2t(xMax+pad, yMin-pad, d.z),
      this.m2t(xMax+pad, yMax+pad, d.z),
      this.m2t(xMin-pad, yMax+pad, d.z),
      this.m2t(xMin-pad, yMin-pad, d.z),
    ];
    const outlineGeo = new THREE.BufferGeometry().setFromPoints(corners);
    grp.add(new THREE.Line(outlineGeo,
      new THREE.LineBasicMaterial({ color: DIA_COL, transparent: true, opacity: 0.7 })
    ));

    // Connect master node to CM with dashed-style segments
    const masterId = d.masterId || d.nodes[0];
    const master   = this.app.model.nodes.get(masterId);
    if (master) {
      const cmx = (d.cm?.x ?? cx) + (d.eccentricity?.ex ?? 0);
      const cmy = (d.cm?.y ?? cy) + (d.eccentricity?.ey ?? 0);
      const linePts = [this.m2t(master.x, master.y, d.z), this.m2t(cmx, cmy, d.z)];
      grp.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(linePts),
        new THREE.LineBasicMaterial({ color: CM_COL, transparent: true, opacity: 0.5 })
      ));

      // CM marker (cross + circle)
      const s = 0.25;
      const crossPts = [
        this.m2t(cmx-s, cmy, d.z), this.m2t(cmx+s, cmy, d.z)
      ];
      const crossPts2 = [
        this.m2t(cmx, cmy-s, d.z), this.m2t(cmx, cmy+s, d.z)
      ];
      const cmMat = new THREE.LineBasicMaterial({ color: CM_COL });
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(crossPts),  cmMat));
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(crossPts2), cmMat));

      // Circle around CM
      const R = 0.35, nSeg = 16;
      const circPts = [];
      for (let i = 0; i <= nSeg; i++) {
        const a = (i / nSeg) * Math.PI * 2;
        circPts.push(this.m2t(cmx + R*Math.cos(a), cmy + R*Math.sin(a), d.z));
      }
      grp.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(circPts),
        new THREE.LineBasicMaterial({ color: CM_COL, transparent: true, opacity: 0.8 })
      ));

      // Clickable sphere at CM position (invisible but raycast target)
      const cmSphere = new THREE.Mesh(
        new THREE.SphereGeometry(R * 1.1, 8, 8),
        new THREE.MeshBasicMaterial({ color: CM_COL, transparent: true, opacity: 0.0 })
      );
      cmSphere.position.copy(this.m2t(cmx, cmy, d.z));
      cmSphere.userData = { type: 'cm-sphere', diaId: d.id };
      grp.add(cmSphere);
    }

    grp.userData = { type: 'diaphragm', id: d.id };
    return grp;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RESULTS VISUALIZATION
  // ══════════════════════════════════════════════════════════════════════════

  clearResults() {
    // Stop animation
    this._animFn = null;
    this._animMeshNodes = [];
    this._animLineElems = [];

    if (!this._resultObjects) return;
    for (const obj of this._resultObjects) this._scene.remove(obj);
    this._resultObjects = [];
    for (const [id, mesh] of this._nodeMeshes) {
      const node = this.app.model.nodes.get(id);
      if (node) mesh.material.color.set(this._nodeColor(node));
      mesh.visible = true;
    }
    for (const [, line] of this._elemLines) {
      line.material.color.set(COL.ELEM);
      line.visible = true;
    }
    for (const [, grp] of this._suppGroups) grp.visible = true;
    this._inResultsMode = false;
    document.getElementById('results-banner').classList.remove('visible');
    document.getElementById('results-overlay').classList.add('hidden');
    document.getElementById('modal-analysis-overlay')?.classList.add('hidden');
    const lco = document.getElementById('lc-overlay');
    if (lco) lco.style.display = '';
    document.getElementById('btn-clear-results').style.display = 'none';
  }

  showDeformed(results, scale) {
    this.clearLoads();
    this.clearResults();
    this._resultObjects = [];
    this._inResultsMode = true;

    const maxD = results.getMaxDisp();
    if (!scale) {
      const b = this.app.model.getBounds();
      const span = Math.max(b.max.x-b.min.x, b.max.y-b.min.y, b.max.z-b.min.z, 1);
      scale = maxD > 1e-12 ? span / 50 / maxD : 100;
    }
    document.getElementById('result-scale').value = Math.round(scale);

    // Ghost original model
    for (const [, line] of this._elemLines) line.material.color.set(0x222840);
    for (const [, mesh] of this._nodeMeshes) mesh.visible = false;
    for (const [, grp]  of this._suppGroups)  grp.visible  = false;

    for (const elem of this.app.model.elements.values()) {
      const dc1 = results.getDeformedCoords(elem.n1, scale);
      const dc2 = results.getDeformedCoords(elem.n2, scale);
      const d1  = Math.hypot(...results.getNodeDisp(elem.n1).slice(0,3));
      const d2  = Math.hypot(...results.getNodeDisp(elem.n2).slice(0,3));
      const t   = maxD > 1e-12 ? (d1+d2)/2/maxD : 0;
      const geo = new THREE.BufferGeometry().setFromPoints([
        this.m2t(dc1.x, dc1.y, dc1.z), this.m2t(dc2.x, dc2.y, dc2.z)
      ]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: _dispColor(t) }));
      this._scene.add(line);
      this._resultObjects.push(line);
    }
    for (const node of this.app.model.nodes.values()) {
      const dc   = results.getDeformedCoords(node.id, scale);
      const dmag = Math.hypot(...results.getNodeDisp(node.id).slice(0,3));
      const t    = maxD > 1e-12 ? dmag/maxD : 0;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(NODE_R*0.8, 6, 6),
        new THREE.MeshBasicMaterial({ color: _dispColor(t) })
      );
      mesh.position.copy(this.m2t(dc.x, dc.y, dc.z));
      this._scene.add(mesh);
      this._resultObjects.push(mesh);
    }
    this._showResultsUI(`Deformada ×${Math.round(scale)} | δmax=${_fmt(maxD)}`);
  }

  showForceDiagram(results, type, scale) {
    this.clearLoads();
    this.clearResults();
    this._resultObjects = [];
    this._inResultsMode = true;

    let maxVal = 0;
    for (const elem of this.app.model.elements.values()) {
      for (const p of results.getDiagramData(elem.id, type, 2))
        if (Math.abs(p.val) > maxVal) maxVal = Math.abs(p.val);
    }
    if (!scale) {
      const b = this.app.model.getBounds();
      const span = Math.max(b.max.x-b.min.x, b.max.y-b.min.y, b.max.z-b.min.z, 1);
      scale = maxVal > 1e-12 ? span * 0.15 / maxVal : 1;
    }
    document.getElementById('result-scale').value = +scale.toExponential(3);

    for (const [, line] of this._elemLines) line.material.color.set(0x222840);
    const useLocalZ = (type === 'My' || type === 'Vz');

    for (const elem of this.app.model.elements.values()) {
      const f = results.getElemForces(elem.id);
      if (!f) continue;
      const pts = results.getDiagramData(elem.id, type, 12);

      // Perpendicular direction for diagram (in Three.js coords)
      const perpDir = useLocalZ
        ? new THREE.Vector3(f.ez[0], f.ez[2], f.ez[1])
        : new THREE.Vector3(f.ey[0], f.ey[2], f.ey[1]);

      const linePoints = [];
      const fillVerts  = [];

      for (const { pos, val } of pts) {
        const baseP = this.m2t(pos.x, pos.y, pos.z);
        const diagP = baseP.clone().addScaledVector(perpDir, val * scale);
        linePoints.push(diagP);
        fillVerts.push(baseP.x, baseP.y, baseP.z, diagP.x, diagP.y, diagP.z);
      }
      // Close polygon back to baseline
      const last = pts[pts.length-1];
      linePoints.push(this.m2t(last.pos.x, last.pos.y, last.pos.z));
      for (let i = pts.length-1; i >= 0; i--) {
        const { pos } = pts[i];
        linePoints.push(this.m2t(pos.x, pos.y, pos.z));
      }

      const avgAbs = pts.reduce((s,p)=>s+Math.abs(p.val),0)/pts.length;
      const col = maxVal > 1e-12 ? _forceColor(avgAbs/maxVal) : 0xffc107;

      const outlineGeo = new THREE.BufferGeometry().setFromPoints(linePoints);
      const outline = new THREE.Line(outlineGeo, new THREE.LineBasicMaterial({ color: col }));
      this._scene.add(outline);
      this._resultObjects.push(outline);

      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fillVerts, 3));
      const fill = new THREE.LineSegments(fillGeo,
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.3 })
      );
      this._scene.add(fill);
      this._resultObjects.push(fill);
    }
    this._showResultsUI(`${type} | max = ${_fmt(maxVal)}`);
  }

  _showResultsUI(summary) {
    document.getElementById('results-overlay').classList.remove('hidden');
    const lco = document.getElementById('lc-overlay');
    if (lco) lco.style.display = 'none';
    document.getElementById('result-summary').textContent = summary;
    document.getElementById('results-banner').classList.add('visible');
    document.getElementById('btn-clear-results').style.display = '';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MODAL / DYNAMIC VISUALIZATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Display a single mode shape (static snapshot at factor=1).
   * Sets up _animMeshNodes and _animLineElems for live animation updates.
   * @param {ModalResults} modalResults
   * @param {number}       modeIndex   0-based
   * @param {number}       scale       visual amplitude in model units
   */
  showModeShape(modalResults, modeIndex, scale = 1.0) {
    this.clearResults();
    this._resultObjects = [];
    this._inResultsMode = true;
    this._animMeshNodes = [];
    this._animLineElems = [];

    // Dim original model
    for (const [, line] of this._elemLines) line.material.color.set(0x1e2840);
    for (const [, mesh] of this._nodeMeshes) mesh.visible = false;
    for (const [, grp]  of this._suppGroups) grp.visible  = false;

    const shape = modalResults.getModeShape(modeIndex);

    // ── Deformed elements ────────────────────────────────────────────────────
    for (const elem of this.app.model.elements.values()) {
      const n1 = this.app.model.nodes.get(elem.n1);
      const n2 = this.app.model.nodes.get(elem.n2);
      if (!n1 || !n2) continue;

      const d1 = shape.get(elem.n1) || _zeroDisp;
      const d2 = shape.get(elem.n2) || _zeroDisp;

      const p1base = this.m2t(n1.x, n1.y, n1.z);
      const p2base = this.m2t(n2.x, n2.y, n2.z);
      // Displacement vectors in Three.js coords (same m2t transform)
      const dp1 = new THREE.Vector3(d1[0], d1[2], d1[1]);
      const dp2 = new THREE.Vector3(d2[0], d2[2], d2[1]);

      const geo = new THREE.BufferGeometry().setFromPoints([
        p1base.clone().addScaledVector(dp1, scale),
        p2base.clone().addScaledVector(dp2, scale)
      ]);
      const mat  = new THREE.LineBasicMaterial({ color: 0x4fc3f7 });
      const line = new THREE.Line(geo, mat);
      this._scene.add(line);
      this._resultObjects.push(line);
      this._animLineElems.push({ geo, p1base, p2base, dp1, dp2 });
    }

    // ── Deformed nodes ───────────────────────────────────────────────────────
    for (const node of this.app.model.nodes.values()) {
      const d     = shape.get(node.id) || _zeroDisp;
      const pbase = this.m2t(node.x, node.y, node.z);
      const dp    = new THREE.Vector3(d[0], d[2], d[1]);

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(NODE_R * 0.85, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0x4fc3f7 })
      );
      mesh.position.copy(pbase.clone().addScaledVector(dp, scale));
      this._scene.add(mesh);
      this._resultObjects.push(mesh);
      this._animMeshNodes.push({ mesh, pbase, dp });
    }

    // Hide LC overlay, show clear button, keep modal overlay visible
    const lco = document.getElementById('lc-overlay');
    if (lco) lco.style.display = 'none';
    document.getElementById('btn-clear-results').style.display = '';
    document.getElementById('results-banner').classList.add('visible');
    document.getElementById('results-banner').textContent =
      'MODO DINÁMICO — haga clic sobre nodos y elementos para ver valores';
    document.getElementById('modal-analysis-overlay')?.classList.remove('hidden');
  }

  /**
   * Update geometry positions with the given amplitude factor (−1…+1).
   * Called each animation frame.
   */
  _applyModeShapeScale(scale, factor) {
    const s = scale * factor;
    for (const { mesh, pbase, dp } of this._animMeshNodes) {
      mesh.position.copy(pbase).addScaledVector(dp, s);
    }
    for (const { geo, p1base, p2base, dp1, dp2 } of this._animLineElems) {
      const pos = geo.attributes.position;
      const p1  = p1base.clone().addScaledVector(dp1, s);
      const p2  = p2base.clone().addScaledVector(dp2, s);
      pos.setXYZ(0, p1.x, p1.y, p1.z);
      pos.setXYZ(1, p2.x, p2.y, p2.z);
      pos.needsUpdate = true;
    }
  }

  /**
   * Start oscillating animation of the currently shown mode shape.
   * @param {number} scale  visual amplitude (model units)
   * @param {number} speed  multiplier on angular speed (1 = normal)
   */
  startModeAnimation(scale, speed = 1.0) {
    this._animT = 0;
    this._animFn = () => {
      this._animT += 0.045 * speed;
      this._applyModeShapeScale(scale, Math.sin(this._animT));
    };
  }

  /** Pause animation and show mode at full positive amplitude. */
  stopAnimation(scale) {
    this._animFn = null;
    this._applyModeShapeScale(scale, 1.0);
  }

  // ── Load visualization ────────────────────────────────────────────────────
  clearLoads() {
    for (const obj of this._loadObjects) this._scene.remove(obj);
    this._loadObjects = [];
  }

  showLoads(model, lcId) {
    this.clearLoads();
    const lc = model.loadCases.get(lcId);
    if (!lc || lc.loads.length === 0) return;

    const b    = model.getBounds();
    const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, 1);
    const baseLen = span * 0.28;

    // Find max force magnitude for proportional scaling
    let maxF = 0;
    for (const ld of lc.loads) {
      if (ld.type === 'nodal') {
        const mag = Math.hypot(ld.F[0], ld.F[1], ld.F[2]);
        if (mag > maxF) maxF = mag;
      } else if (ld.type === 'dist') {
        if (Math.abs(ld.w) > maxF) maxF = Math.abs(ld.w);
      }
    }
    if (maxF < 1e-30) return;

    const addArrow = (dir3, origin, frac, color) => {
      const len = Math.max(0.04, baseLen * frac);
      const hl  = len * 0.28;
      const hw  = len * 0.14;
      const arrow = new THREE.ArrowHelper(dir3.clone().normalize(), origin, len, color, hl, hw);
      this._scene.add(arrow);
      this._loadObjects.push(arrow);
    };

    // Model-direction → Three.js direction (m2t for vectors: x→x, y→z, z→y)
    const dirMap = {
      globalX: new THREE.Vector3( 1, 0, 0),
      globalY: new THREE.Vector3( 0, 0, 1),
      globalZ: new THREE.Vector3( 0, 1, 0),
    };

    for (const ld of lc.loads) {
      if (ld.type === 'nodal') {
        const node = model.nodes.get(ld.nodeId);
        if (!node) continue;
        const origin = this.m2t(node.x, node.y, node.z);
        // Fx, Fy, Fz components
        const comps = [
          { f: ld.F[0], dir: new THREE.Vector3( 1, 0, 0) },
          { f: ld.F[1], dir: new THREE.Vector3( 0, 0, 1) },
          { f: ld.F[2], dir: new THREE.Vector3( 0, 1, 0) },
        ];
        for (const { f, dir } of comps) {
          if (Math.abs(f) < 1e-12) continue;
          addArrow(dir.multiplyScalar(Math.sign(f)), origin, Math.abs(f) / maxF, 0xffc107);
        }

      } else if (ld.type === 'dist') {
        const elem = model.elements.get(ld.elemId);
        if (!elem) continue;
        const n1 = model.nodes.get(elem.n1);
        const n2 = model.nodes.get(elem.n2);
        if (!n1 || !n2) continue;
        const p1 = this.m2t(n1.x, n1.y, n1.z);
        const p2 = this.m2t(n2.x, n2.y, n2.z);

        let dir3 = (dirMap[ld.dir] || new THREE.Vector3(0, -1, 0)).clone();
        dir3.multiplyScalar(Math.sign(ld.w || -1));
        const frac = Math.abs(ld.w) / maxF * 0.75;

        const N = 6;
        for (let k = 0; k <= N; k++) {
          const t = k / N;
          const o = p1.clone().lerp(p2, t);
          addArrow(dir3, o, frac, 0x4ade80);
        }
      }
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────────
const _zeroDisp = [0, 0, 0, 0, 0, 0];

// ── Color helpers ────────────────────────────────────────────────────────────
// t ∈ [0,1] → blue→cyan→green→yellow→red
function _dispColor(t) {
  const r = Math.min(1, t * 2);
  const b = Math.max(0, 1 - t * 2);
  const g = t < 0.5 ? t * 2 : (1 - t) * 2;
  return new THREE.Color(r, g, b);
}
function _forceColor(t) {
  return _dispColor(t);
}
function _fmt(v) {
  if (Math.abs(v) < 1e-12) return '0';
  if (Math.abs(v) < 0.001 || Math.abs(v) >= 1e5) return v.toExponential(3);
  return v.toPrecision(4);
}
