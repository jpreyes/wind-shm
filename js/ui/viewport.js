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

    // P2-6: node/element ID sprites
    this._showIds   = false;
    this._idSprites = [];

    // P4-13: extruded section objects
    this._showExtruded    = false;
    this._extrudedObjects = [];
    this._extrusionLight  = null;

    // P3-10: node drag state
    this._dragNode     = null;
    this._dragStartPos = null;
    this._isDragging   = false;

    // Results state
    this._results             = null;
    this._currentDiagramType  = null;

    // Inspector panel
    this._inspPanel  = null;
    this._inspElemId = null;
    this._inspXi     = 0.5;
    this._inspType   = 'Mz';
    this._inspDragOffset = null;

    this._init();
  }

  // ── Coordinate transforms ──────────────────────────────────────────────────
  m2t(x, y, z) { return new THREE.Vector3(x, z, y); }
  t2m(v)       { return { x: v.x, y: v.z, z: v.y }; }

  // ── Initialization ─────────────────────────────────────────────────────────
  _init() {
    // Renderer
    this._renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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

    const axesDef = [
      { dir: new THREE.Vector3(1, 0, 0), col: COL.AXIS_X, label: 'X' },  // model X → Three.js +X
      { dir: new THREE.Vector3(0, 0, 1), col: COL.AXIS_Y, label: 'Y' },  // model Y → Three.js +Z
      { dir: new THREE.Vector3(0, 1, 0), col: COL.AXIS_Z, label: 'Z' },  // model Z(up) → Three.js +Y
    ];
    for (const { dir, col, label } of axesDef) {
      this._axesGroup.add(new THREE.ArrowHelper(dir, new THREE.Vector3(0,0,0), len, col, hw, hr));
      const cssCol = '#' + col.toString(16).padStart(6, '0');
      const sp = this._makeAxisLabel(label, cssCol);
      sp.position.copy(dir.clone().multiplyScalar(len + 0.48));
      this._axesGroup.add(sp);
    }
    this._scene.add(this._axesGroup);
  }

  _makeAxisLabel(text, cssColor) {
    const canvas = document.createElement('canvas');
    canvas.width = 48; canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 48, 48);
    ctx.font = 'bold 32px sans-serif';
    ctx.fillStyle = cssColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 24, 26);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sp  = new THREE.Sprite(mat);
    sp.scale.set(0.55, 0.55, 1);
    return sp;
  }

  /** Canvas-based sprite label for diagram max/min values */
  _makeDiagramLabel(text, pos) {
    const W = 140, H = 30;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10,14,26,0.72)';
    ctx.fillRect(0, 0, W, H);
    ctx.font = 'bold 17px sans-serif';
    ctx.fillStyle = '#ffee58';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sp  = new THREE.Sprite(mat);
    sp.scale.set(1.4, 0.3, 1);
    sp.position.copy(pos);
    return sp;
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
    // Refresh ID sprites if they were visible
    if (this._showIds) { this._showIds = false; this.toggleIds(); }
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

  // ── Support symbol — 3D cones / boxes pointing downward (−Y in Three.js) ──
  _buildSuppSymbol(node) {
    const existing = this._suppGroups.get(node.id);
    if (existing) this._scene.remove(existing);

    const r = node.restraints;
    const transCount = (r.ux ? 1 : 0) + (r.uy ? 1 : 0) + (r.uz ? 1 : 0);
    const rotCount   = (r.rx ? 1 : 0) + (r.ry ? 1 : 0) + (r.rz ? 1 : 0);
    if (transCount === 0 && rotCount === 0) { this._suppGroups.delete(node.id); return; }

    const allFixed   = transCount === 3 && rotCount === 3;
    const transFixed = transCount === 3;
    const partial    = transCount > 0 && !transFixed;

    const grp = new THREE.Group();
    const s = 0.32;

    const addMesh = (geo, col, opacity = 0.85, wireframe = false) => {
      const m = new THREE.Mesh(geo,
        new THREE.MeshBasicMaterial({ color: col, transparent: opacity < 1, opacity, wireframe }));
      grp.add(m);
      return m;
    };
    const addLine = (pts, col, opacity = 1) => {
      const mat = new THREE.LineBasicMaterial({ color: col, transparent: opacity < 1, opacity });
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    };

    if (allFixed) {
      // ── Empotrado (6 DOF): wireframe square-pyramid + plate — RED ────────
      const col = COL.NODE_FIXED;
      const cH  = s * 1.5;
      const cone = addMesh(new THREE.ConeGeometry(s * 0.72, cH, 4, 1), col, 0.75, true);
      cone.rotation.y = Math.PI / 4;   // rotate 45° so edges face front
      cone.position.y = -cH / 2;
      const bH = s * 0.38;
      const box = addMesh(new THREE.BoxGeometry(s * 1.7, bH, s * 1.7), col, 0.45, true);
      box.position.y = -cH - bH / 2;
      // Cross-hatch on base plate (two diagonals)
      const by = -cH, bw = s * 0.85;
      addLine([new THREE.Vector3(-bw, by, -bw), new THREE.Vector3(bw, by, bw)], col, 0.35);
      addLine([new THREE.Vector3(bw,  by, -bw), new THREE.Vector3(-bw, by, bw)], col, 0.35);

    } else if (transFixed) {
      // ── Pin / Articulado (3 trans): wireframe pyramid + hatch — ORANGE ───
      const col = COL.NODE_PIN;
      const cH  = s * 1.7;
      const cone = addMesh(new THREE.ConeGeometry(s * 0.72, cH, 4, 1), col, 0.75, true);
      cone.rotation.y = Math.PI / 4;
      cone.position.y = -cH / 2;
      const bY = -cH;
      // Horizontal base line (in both X and Z planes)
      addLine([new THREE.Vector3(-s*0.95, bY, 0), new THREE.Vector3(s*0.95, bY, 0)], col);
      addLine([new THREE.Vector3(0, bY, -s*0.95), new THREE.Vector3(0, bY, s*0.95)], col, 0.45);
      // Diagonal hatch below base
      for (let i = 0; i < 5; i++) {
        const t = -s * 0.8 + i * s * 0.4;
        addLine([new THREE.Vector3(t, bY, 0), new THREE.Vector3(t - s*0.24, bY - s*0.42, 0)], col, 0.55);
      }

    } else if (partial) {
      // ── Deslizante / Roller (1–2 trans): small pyramid + disk — CYAN ─────
      const col = 0x00bcd4;
      const cH  = s * 1.1;
      const cone = addMesh(new THREE.ConeGeometry(s * 0.5, cH, 4, 1), col, 0.75, true);
      cone.rotation.y = Math.PI / 4;
      cone.position.y = -cH / 2;
      // Roller disk
      const disk = addMesh(new THREE.CylinderGeometry(s * 0.62, s * 0.62, s * 0.1, 16), col, 0.35);
      disk.position.y = -cH - s * 0.05;
      // Circle outline for clarity
      const pts = [];
      for (let k = 0; k <= 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        pts.push(new THREE.Vector3(s * 0.62 * Math.cos(a), -cH, s * 0.62 * Math.sin(a)));
      }
      addLine(pts, col, 0.75);

    } else {
      // ── Solo rotaciones: anillo plano — YELLOW ────────────────────────────
      const col = 0xd29922;
      const ring = addMesh(new THREE.TorusGeometry(s * 0.38, s * 0.075, 6, 20), col, 0.85);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -s * 0.05;
    }

    // ── Tooltip label showing which DOFs are fixed ────────────────────────
    const dofLabel = [
      r.ux ? 'Ux' : '', r.uy ? 'Uy' : '', r.uz ? 'Uz' : '',
      r.rx ? 'Rx' : '', r.ry ? 'Ry' : '', r.rz ? 'Rz' : '',
    ].filter(Boolean).join(' ');
    grp.userData = { type: 'support', nodeId: node.id, dofLabel };

    grp.position.copy(this.m2t(node.x, node.y, node.z));
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

    // P3-10: Node drag handling ───────────────────────────────────────────────
    if (this._dragNode !== null && (e.buttons & 1)) {
      if (!this._isDragging) {
        // Require minimum mouse movement to start a drag
        if (this._ptrDownPos) {
          const ddx = e.clientX - this._ptrDownPos[0];
          const ddy = e.clientY - this._ptrDownPos[1];
          if (Math.hypot(ddx, ddy) < 4) return;
        }
        this._isDragging = true;
        this.app.snapshot();   // save state once, before first move
        this._renderer.domElement.style.cursor = 'move';
      }
      const node = this.app.model.nodes.get(this._dragNode);
      if (node) {
        // Project onto the horizontal plane at the node's Z
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -node.z);
        const pt    = new THREE.Vector3();
        this._raycaster.ray.intersectPlane(plane, pt);
        if (pt && isFinite(pt.x)) {
          let nx = pt.x, ny = pt.z; // Three.js X→model X, Three.js Z→model Y
          if (this._snapSize > 0) {
            nx = Math.round(nx / this._snapSize) * this._snapSize;
            ny = Math.round(ny / this._snapSize) * this._snapSize;
          }
          node.x = nx; node.y = ny;
          const mesh = this._nodeMeshes.get(this._dragNode);
          if (mesh) mesh.position.copy(this.m2t(node.x, node.y, node.z));
          // Update connected element geometries live
          for (const [eid, line] of this._elemLines) {
            if (line.userData.n1 === this._dragNode || line.userData.n2 === this._dragNode) {
              const elem = this.app.model.elements.get(eid);
              if (elem) this.addElemLine(elem);
            }
          }
          document.getElementById('sb-coords').textContent =
            `X: ${nx.toFixed(3)}  Y: ${ny.toFixed(3)}  Z: ${node.z.toFixed(3)}`;
        }
      }
      return; // skip normal hover/preview while dragging
    }

    // Update coord display (normal move)
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

    // P3-10: Prepare node drag when clicking a selected node in select mode
    if (this.mode === 'select') {
      this._mouse.copy(this._ndc(e));
      this._raycaster.setFromCamera(this._mouse, this._camera);
      const hits = this._raycaster.intersectObjects([...this._nodeMeshes.values()]);
      if (hits.length) {
        const id = hits[0].object.userData.id;
        if (this._selected.has(`node:${id}`)) {
          this._dragNode     = id;
          const node         = this.app.model.nodes.get(id);
          if (node) this._dragStartPos = { x: node.x, y: node.y, z: node.z };
          this._controls.enabled = false; // prevent orbit while dragging
        }
      }
    }
  }

  _onUp(e) {
    if (e.button !== 0) return;

    // P3-10: Commit or cancel node drag ──────────────────────────────────────
    if (this._isDragging) {
      const node = this.app.model.nodes.get(this._dragNode);
      if (node) {
        this.refreshNode(node);          // sync support symbol, connected elems
        this.app.markDirty();
        if (this.app.panel._currentTab === 'sel') this.app.panel.showNode(node);
      }
      this._isDragging   = false;
      this._dragNode     = null;
      this._dragStartPos = null;
      this._controls.enabled = true;
      this._ptrDownPos   = null;
      this._renderer.domElement.style.cursor = 'default';
      return;
    }
    // Cancel drag prep if no movement
    if (this._dragNode !== null) {
      this._dragNode     = null;
      this._dragStartPos = null;
      this._controls.enabled = true;
    }

    if (!this._ptrDownPos) return;
    const dx = e.clientX - this._ptrDownPos[0];
    const dy = e.clientY - this._ptrDownPos[1];
    this._ptrDownPos = null;
    if (Math.hypot(dx, dy) > 6) return; // was an orbit drag

    this._mouse.copy(this._ndc(e));
    this._raycaster.setFromCamera(this._mouse, this._camera);

    if (this._inResultsMode) {
      this._clickResults(e);
      return;
    }

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
    // P3-12: Show coordinate confirmation popup instead of placing immediately
    this._showNodeCoordPopup(mc);
  }

  /** P3-12: Mini popup to confirm / adjust node coordinates before placing. */
  _showNodeCoordPopup(mc) {
    document.getElementById('node-coord-popup')?.remove();

    const popup = document.createElement('div');
    popup.id = 'node-coord-popup';
    popup.style.cssText = [
      'position:absolute', 'bottom:44px', 'left:50%', 'transform:translateX(-50%)',
      'background:var(--bg3,#21262d)', 'border:1px solid var(--accent,#388bfd)',
      'border-radius:6px', 'padding:8px 12px', 'z-index:20',
      'display:flex', 'gap:6px', 'align-items:center',
      'box-shadow:0 4px 20px rgba(0,0,0,0.6)', 'pointer-events:all',
    ].join(';');

    const inp = (id, val) =>
      `<input type="number" id="${id}" value="${val.toFixed(3)}" step="0.1"
         style="width:60px;font-size:11px;background:var(--bg4,#30363d);
                border:1px solid var(--border2,#484f58);color:var(--text,#c9d1d9);
                padding:3px 5px;border-radius:3px;font-family:monospace">`;

    popup.innerHTML = `
      <span style="color:var(--text-muted);font-size:11px;white-space:nowrap">Nuevo nodo:</span>
      <label style="font-size:11px;color:var(--text-muted)">X</label>${inp('np-x', mc.x)}
      <label style="font-size:11px;color:var(--text-muted)">Y</label>${inp('np-y', mc.y)}
      <label style="font-size:11px;color:var(--text-muted)">Z</label>${inp('np-z', mc.z)}
      <button id="np-ok"
        style="background:var(--accent,#388bfd);color:#fff;border:none;
               padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px">✓</button>
      <button id="np-cancel"
        style="background:transparent;color:var(--text-muted);
               border:1px solid var(--border2,#484f58);
               padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px">✕</button>`;

    const vpWrap = document.getElementById('viewport-wrap') || this.container.parentElement;
    vpWrap.appendChild(popup);
    const xEl = document.getElementById('np-x');
    xEl?.focus(); xEl?.select();

    const confirm = () => {
      const x = parseFloat(document.getElementById('np-x')?.value);
      const y = parseFloat(document.getElementById('np-y')?.value);
      const z = parseFloat(document.getElementById('np-z')?.value);
      popup.remove();
      if (isFinite(x) && isFinite(y) && isFinite(z)) this.app.addNode(x, y, z);
    };
    document.getElementById('np-ok')?.addEventListener('click', confirm);
    document.getElementById('np-cancel')?.addEventListener('click', () => popup.remove());
    popup.addEventListener('keydown', ev => {
      if (ev.key === 'Enter')  confirm();
      if (ev.key === 'Escape') popup.remove();
      ev.stopPropagation();
    });
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

  // Andrew's monotone chain — returns convex hull of [{x,y}] in CCW order
  _convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    const sorted = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
    const cross = (o, a, b) =>
      (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [], upper = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0)
        lower.pop();
      lower.push(p);
    }
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0)
        upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return [...lower, ...upper];
  }

  _buildDiaphragmViz(d) {
    const nodes = d.nodes
      .map(id => this.app.model.nodes.get(id))
      .filter(Boolean);
    if (nodes.length < 2) return null;

    const grp    = new THREE.Group();
    const DIA_COL = 0x00bcd4;  // cyan  — diaphragm outline
    const CM_COL  = 0xff7043;  // orange — CM marker
    const CR_COL  = 0x00e5ff;  // bright cyan — CR / master marker

    // ── Convex-hull floor shape ────────────────────────────────────────────
    const PAD  = 0.25;
    const hull = this._convexHull(nodes.map(n => ({ x: n.x, y: n.y })));

    // Expand slightly outward from hull centroid
    const hcx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
    const hcy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
    const padded = hull.map(p => ({
      x: p.x + (p.x >= hcx ? PAD : -PAD),
      y: p.y + (p.y >= hcy ? PAD : -PAD),
    }));

    // Filled polygon (click target).
    // m2t: model(x,y,z)→Three(x,z,y).  ShapeGeometry in XY + rotation.x=+π/2
    // gives local(x,y)→world(x, d.z, y)  ✓
    const shape = new THREE.Shape(padded.map(p => new THREE.Vector2(p.x, p.y)));
    const planeMat = new THREE.MeshBasicMaterial({
      color: DIA_COL, transparent: true, opacity: 0.07,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const plane = new THREE.Mesh(new THREE.ShapeGeometry(shape), planeMat);
    plane.position.set(0, d.z, 0);
    plane.rotation.x = Math.PI / 2;
    plane.userData = { type: 'diaphragm', id: d.id };
    grp.add(plane);

    // Polygon outline
    const outlinePts = [...padded, padded[0]].map(p => this.m2t(p.x, p.y, d.z));
    grp.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(outlinePts),
      new THREE.LineBasicMaterial({ color: DIA_COL, transparent: true, opacity: 0.75 }),
    ));

    // ── CM and CR markers ──────────────────────────────────────────────────
    const masterId = d.masterId || d.nodes[0];
    const master   = this.app.model.nodes.get(masterId);
    if (master) {
      const crx = master.x, cry = master.y;
      const cmx = (d.cm?.x ?? hcx) + (d.eccentricity?.ex ?? 0);
      const cmy = (d.cm?.y ?? hcy) + (d.eccentricity?.ey ?? 0);

      // Line CR → CM
      grp.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          this.m2t(crx, cry, d.z), this.m2t(cmx, cmy, d.z)
        ]),
        new THREE.LineBasicMaterial({ color: CM_COL, transparent: true, opacity: 0.5 }),
      ));

      // CM marker: cross + circle (orange)
      const s = 0.25, R = 0.35, nSeg = 16;
      const cmMat = new THREE.LineBasicMaterial({ color: CM_COL });
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [this.m2t(cmx-s, cmy, d.z), this.m2t(cmx+s, cmy, d.z)]), cmMat));
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [this.m2t(cmx, cmy-s, d.z), this.m2t(cmx, cmy+s, d.z)]), cmMat));
      const circPts = [];
      for (let i = 0; i <= nSeg; i++) {
        const a = (i / nSeg) * Math.PI * 2;
        circPts.push(this.m2t(cmx + R*Math.cos(a), cmy + R*Math.sin(a), d.z));
      }
      grp.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(circPts),
        new THREE.LineBasicMaterial({ color: CM_COL, transparent: true, opacity: 0.8 }),
      ));
      // Invisible click sphere at CM
      const cmSphere = new THREE.Mesh(
        new THREE.SphereGeometry(R * 1.1, 8, 8),
        new THREE.MeshBasicMaterial({ color: CM_COL, transparent: true, opacity: 0.0 }),
      );
      cmSphere.position.copy(this.m2t(cmx, cmy, d.z));
      cmSphere.userData = { type: 'cm-sphere', diaId: d.id };
      grp.add(cmSphere);

      // CR marker: square outline (bright cyan) at master node position
      const hs = 0.32;  // half-side
      const crMat = new THREE.LineBasicMaterial({ color: CR_COL });
      const sqPts = [
        this.m2t(crx-hs, cry-hs, d.z), this.m2t(crx+hs, cry-hs, d.z),
        this.m2t(crx+hs, cry+hs, d.z), this.m2t(crx-hs, cry+hs, d.z),
        this.m2t(crx-hs, cry-hs, d.z),
      ];
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sqPts), crMat));
      // Diagonal cross inside square
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [this.m2t(crx-hs, cry-hs, d.z), this.m2t(crx+hs, cry+hs, d.z)]), crMat));
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [this.m2t(crx+hs, cry-hs, d.z), this.m2t(crx-hs, cry+hs, d.z)]), crMat));
    }

    grp.userData = { type: 'diaphragm', id: d.id };
    return grp;
  }

  // �?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
  // RESULTS VISUALIZATION
  // �?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?

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
    this._results = null;
    this._currentDiagramType = null;
    this._hideInspector();
    document.getElementById('results-banner').classList.remove('visible');
    document.getElementById('results-overlay').classList.add('hidden');
    document.getElementById('modal-analysis-overlay')?.classList.add('hidden');
    const lco = document.getElementById('lc-overlay');
    if (lco) lco.style.display = '';
    document.getElementById('btn-clear-results').style.display = 'none';
    // Hide colorbar
    const cbw = document.getElementById('colorbar-wrap');
    if (cbw) cbw.style.display = 'none';
  }

  showDeformed(results, scale) {
    this.clearLoads();
    this.clearResults();
    this._resultObjects = [];
    this._inResultsMode = true;
    this._results = results;
    this._currentDiagramType = null;

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
    this._drawColorbar(0, maxD);
  }

  showForceDiagram(results, type, scale) {
    this.clearLoads();
    this.clearResults();
    this._resultObjects = [];
    this._inResultsMode = true;
    this._results = results;
    this._currentDiagramType = type;

    // ── normalise getDiagramData return (supports old array format too) ──────
    const _normDiagram = raw => Array.isArray(raw)
      ? { pts: raw, extremes: [] }
      : (raw && raw.pts ? raw : { pts: [], extremes: [] });

    // ── Pass 1: find global max absolute value (includes analytical extrema) ──
    let maxVal = 0;
    for (const elem of this.app.model.elements.values()) {
      const d = _normDiagram(results.getDiagramData(elem.id, type, 2));
      for (const p of d.pts)      if (Math.abs(p.val)   > maxVal) maxVal = Math.abs(p.val);
      for (const e of d.extremes) if (Math.abs(e.val)   > maxVal) maxVal = Math.abs(e.val);
    }
    if (!scale) {
      const b = this.app.model.getBounds();
      const span = Math.max(b.max.x-b.min.x, b.max.y-b.min.y, b.max.z-b.min.z, 1);
      scale = maxVal > 1e-12 ? span * 0.15 / maxVal : 1;
    }
    document.getElementById('result-scale').value = +scale.toExponential(3);

    for (const [, line] of this._elemLines) line.material.color.set(0x222840);
    const useLocalZ = (type === 'My' || type === 'Vz');

    // ── Pass 2: draw diagrams ──────────────────────────────────────────────
    for (const elem of this.app.model.elements.values()) {
      const f = results.getElemForces(elem.id);
      if (!f) continue;
      const { pts, extremes } = _normDiagram(results.getDiagramData(elem.id, type, 20));

      // Perpendicular direction for diagram offset (in Three.js coords)
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

      // ── Inner-extreme markers (zero-shear peak for moment diagrams) ──────
      for (const ext of extremes) {
        if (Math.abs(ext.val) < maxVal * 0.005) continue;  // skip noise
        const baseP = this.m2t(ext.pos.x, ext.pos.y, ext.pos.z);
        const tipP  = baseP.clone().addScaledVector(perpDir, ext.val * scale);

        // Small yellow dot at diagram peak
        const dotGeo = new THREE.SphereGeometry(0.06, 6, 4);
        const dot    = new THREE.Mesh(dotGeo,
          new THREE.MeshBasicMaterial({ color: 0xffee58, depthTest: false }));
        dot.position.copy(tipP);
        this._scene.add(dot);
        this._resultObjects.push(dot);

        // Vertical tick line from baseline to peak
        const tickGeo = new THREE.BufferGeometry().setFromPoints([baseP, tipP]);
        const tick    = new THREE.Line(tickGeo,
          new THREE.LineBasicMaterial({ color: 0xffee58, transparent: true, opacity: 0.7 }));
        this._scene.add(tick);
        this._resultObjects.push(tick);

        // Value label offset slightly beyond the peak
        const labelPos = tipP.clone().addScaledVector(
          perpDir, ext.val >= 0 ? 0.28 : -0.28);
        const sp = this._makeDiagramLabel(_fmt(ext.val), labelPos);
        this._scene.add(sp);
        this._resultObjects.push(sp);
      }
    }
    this._showResultsUI(`${type} | max = ${_fmt(maxVal)}`);
    this._drawColorbar(0, maxVal);
  }

  _showResultsUI(summary) {
    document.getElementById('results-overlay').classList.remove('hidden');
    document.getElementById('result-summary').textContent = summary;
    document.getElementById('results-banner').classList.add('visible');
    document.getElementById('btn-clear-results').style.display = '';
  }

  // �?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
  // RESULTS-MODE CLICK & FLOATING INSPECTOR PANEL
  // �?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?

  _clickResults(e) {
    const elemHits = this._raycaster.intersectObjects([...this._elemLines.values()]);
    const nodeHits = this._raycaster.intersectObjects([...this._nodeMeshes.values()]);

    if (elemHits.length) {
      const elemId = elemHits[0].object.userData.id;
      if (this._results) this._showElemInspector(elemId, e.clientX, e.clientY);
    } else if (nodeHits.length) {
      const nodeId = nodeHits[0].object.userData.id;
      if (this._results) this._showNodeInspector(nodeId, e.clientX, e.clientY);
    } else {
      this._hideInspector();
    }
  }

  // ── Inspector panel creation (lazy, one panel reused) ─────────────────────
  _ensureInspPanel() {
    if (this._inspPanel) return;

    const div = document.createElement('div');
    div.className = 'elem-inspector hidden';
    div.innerHTML = `
      <div class="insp-header">
        <span class="insp-title">—</span>
        <button class="insp-close" title="Cerrar">×</button>
      </div>
      <div class="insp-meta"></div>
      <div class="insp-tabs">
        <button class="insp-tab active" data-type="Mz">Mz</button>
        <button class="insp-tab" data-type="My">My</button>
        <button class="insp-tab" data-type="Vy">Vy</button>
        <button class="insp-tab" data-type="Vz">Vz</button>
        <button class="insp-tab" data-type="N">N</button>
        <button class="insp-tab" data-type="T">T</button>
      </div>
      <div class="insp-svg-wrap">
        <svg class="insp-svg" viewBox="0 0 260 70" preserveAspectRatio="none"></svg>
      </div>
      <div class="insp-slider-row">
        <span class="insp-xi-label">ξ = <b class="insp-xi-val">0.50</b></span>
        <input class="insp-xi-slider" type="range" min="0" max="200" value="100">
      </div>
      <div class="insp-forces">
        <div class="ifr"><span>N</span><span class="ifv" data-key="N">—</span></div>
        <div class="ifr"><span>Vy</span><span class="ifv" data-key="Vy">—</span></div>
        <div class="ifr"><span>Vz</span><span class="ifv" data-key="Vz">—</span></div>
        <div class="ifr"><span>T</span><span class="ifv" data-key="T">—</span></div>
        <div class="ifr"><span>My</span><span class="ifv" data-key="My">—</span></div>
        <div class="ifr"><span>Mz</span><span class="ifv" data-key="Mz">—</span></div>
        <div class="ifr ifr-disp"><span>δx</span><span class="ifv" data-key="ux">—</span></div>
        <div class="ifr ifr-disp"><span>δy</span><span class="ifv" data-key="uy">—</span></div>
        <div class="ifr ifr-disp"><span>δz</span><span class="ifv" data-key="uz">—</span></div>
      </div>`;

    document.body.appendChild(div);
    this._inspPanel = div;

    // Close button
    div.querySelector('.insp-close').addEventListener('click', () => this._hideInspector());

    // Drag via header
    const hdr = div.querySelector('.insp-header');
    hdr.addEventListener('mousedown', ev => {
      const rect = div.getBoundingClientRect();
      this._inspDragOffset = { dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
      ev.preventDefault();
    });
    document.addEventListener('mousemove', ev => {
      if (!this._inspDragOffset) return;
      div.style.left = (ev.clientX - this._inspDragOffset.dx) + 'px';
      div.style.top  = (ev.clientY - this._inspDragOffset.dy) + 'px';
    });
    document.addEventListener('mouseup', () => { this._inspDragOffset = null; });

    // Slider
    const slider = div.querySelector('.insp-xi-slider');
    slider.addEventListener('input', () => {
      this._inspXi = slider.value / 200;
      div.querySelector('.insp-xi-val').textContent = this._inspXi.toFixed(2);
      this._updateInspectorForces();
      this._drawInspDiagram();
    });

    // Tabs
    div.querySelectorAll('.insp-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        div.querySelectorAll('.insp-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._inspType = btn.dataset.type;
        this._drawInspDiagram();
      });
    });
  }

  _showElemInspector(elemId, screenX, screenY) {
    this._ensureInspPanel();
    this._inspElemId = elemId;
    this._inspXi     = 0.5;

    const elem = this.app.model.elements.get(elemId);
    const mat  = this.app.model.materials.get(elem?.matId);
    const sec  = this.app.model.sections.get(elem?.secId);
    const f    = this._results.getElemForces(elemId);

    // Position panel near click, keeping it within viewport bounds
    const pw  = 284, ph = 360;
    let left  = screenX + 14;
    let top   = screenY + 14;
    if (left + pw > window.innerWidth  - 4) left = screenX - pw - 14;
    if (top  + ph > window.innerHeight - 4) top  = screenY - ph - 14;
    if (left < 4) left = 4;
    if (top  < 4) top  = 4;
    this._inspPanel.style.left = left + 'px';
    this._inspPanel.style.top  = top  + 'px';

    // Title & meta
    const L = f ? f.L.toFixed(2) : '—';
    this._inspPanel.querySelector('.insp-title').textContent = `Elemento #${elemId}`;
    this._inspPanel.querySelector('.insp-meta').textContent  =
      `L=${L}m  |  ${mat?.name || '—'}  |  ${sec?.name || '—'}`;

    // Reset slider to midspan
    const slider = this._inspPanel.querySelector('.insp-xi-slider');
    slider.value = 100;
    this._inspPanel.querySelector('.insp-xi-val').textContent = '0.50';

    // Set active tab to current diagram type (or Mz if deformed)
    const activeType = this._currentDiagramType || 'Mz';
    this._inspType = activeType;
    this._inspPanel.querySelectorAll('.insp-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.type === activeType);
    });

    this._updateInspectorForces();
    this._drawInspDiagram();
    this._inspPanel.classList.remove('hidden');
  }

  _showNodeInspector(nodeId, screenX, screenY) {
    this._ensureInspPanel();
    this._inspElemId = null;

    const d = this._results.getNodeDisp(nodeId);
    const r = this._results.getReaction(nodeId);

    const pw  = 284, ph = 280;
    let left  = screenX + 14;
    let top   = screenY + 14;
    if (left + pw > window.innerWidth  - 4) left = screenX - pw - 14;
    if (top  + ph > window.innerHeight - 4) top  = screenY - ph - 14;
    if (left < 4) left = 4;
    if (top  < 4) top  = 4;
    this._inspPanel.style.left = left + 'px';
    this._inspPanel.style.top  = top  + 'px';

    this._inspPanel.querySelector('.insp-title').textContent = `Nodo #${nodeId}`;
    this._inspPanel.querySelector('.insp-meta').textContent  = '';

    const vals = {
      N: 'Rx: ' + _fmt(r[0]), Vy: 'Ry: ' + _fmt(r[1]), Vz: 'Rz: ' + _fmt(r[2]),
      T: 'Rmx: '+ _fmt(r[3]), My: 'Rmy: '+ _fmt(r[4]), Mz: 'Rmz: '+ _fmt(r[5]),
      ux: _fmt(d[0]), uy: _fmt(d[1]), uz: _fmt(d[2])
    };
    this._inspPanel.querySelectorAll('.ifv').forEach(el => {
      const k = el.dataset.key;
      el.textContent = vals[k] ?? '—';
    });

    // Clear SVG and slider for node mode
    this._inspPanel.querySelector('.insp-svg').innerHTML = '';
    this._inspPanel.querySelector('.insp-xi-slider').value = 100;

    this._inspPanel.classList.remove('hidden');
  }

  _updateInspectorForces() {
    if (!this._inspElemId || !this._results) return;
    const r = this._results.getElemAtXi(this._inspElemId, this._inspXi);
    if (!r) return;
    this._inspPanel.querySelectorAll('.ifv').forEach(el => {
      const k = el.dataset.key;
      el.textContent = r[k] !== undefined ? _fmt(r[k]) : '—';
    });
  }

  _drawInspDiagram() {
    if (!this._inspElemId || !this._results) return;
    const svg  = this._inspPanel.querySelector('.insp-svg');
    const type = this._inspType;

    const data = this._results.getDiagramData(this._inspElemId, type, 20);
    if (!data.pts.length) { svg.innerHTML = ''; return; }

    const W = 260, H = 70, pad = 4;
    const absMax = Math.max(Math.abs(data.maxVal), Math.abs(data.minVal), 1e-12);
    const yw = (H - pad*2) / 2;
    const baseline = H / 2;
    const N = data.pts.length;

    const xOf = i => pad + (i / (N - 1)) * (W - pad*2);
    const yOf = v => baseline - (v / absMax) * yw;

    // Build SVG path
    let d = `M ${xOf(0).toFixed(1)} ${yOf(data.pts[0].val).toFixed(1)}`;
    for (let i = 1; i < N; i++) {
      d += ` L ${xOf(i).toFixed(1)} ${yOf(data.pts[i].val).toFixed(1)}`;
    }

    // Close back along baseline
    d += ` L ${xOf(N-1).toFixed(1)} ${baseline}`;
    d += ` L ${xOf(0).toFixed(1)} ${baseline} Z`;

    // Current xi marker
    const mx = (pad + this._inspXi * (W - pad*2)).toFixed(1);

    // Extreme markers
    let extDots = '';
    for (const ext of data.extremes) {
      const ex = (pad + ext.xi * (W - pad*2)).toFixed(1);
      const ey = yOf(ext.val).toFixed(1);
      extDots += `<circle cx="${ex}" cy="${ey}" r="3" fill="#ffe082"/>`;
    }

    // Value at xi
    const atXi = this._results.getElemAtXi(this._inspElemId, this._inspXi);
    const vAtXi = atXi ? (type === 'N' ? atXi.N : type === 'Vy' ? atXi.Vy : type === 'Vz' ? atXi.Vz : type === 'T' ? atXi.T : type === 'My' ? atXi.My : atXi.Mz) : null;
    const labelY = vAtXi !== null ? yOf(vAtXi).toFixed(1) : baseline;
    const labelTxt = vAtXi !== null ? _fmt(vAtXi) : '';

    svg.innerHTML = `
      <line x1="${pad}" y1="${baseline}" x2="${W-pad}" y2="${baseline}" stroke="#334" stroke-width="1"/>
      <path d="${d}" fill="rgba(100,180,255,0.18)" stroke="#4fc3f7" stroke-width="1.5"/>
      ${extDots}
      <line x1="${mx}" y1="${pad}" x2="${mx}" y2="${H-pad}" stroke="#ff7043" stroke-width="1.5" stroke-dasharray="3,2"/>
      <circle cx="${mx}" cy="${labelY}" r="3.5" fill="#ff7043"/>
      <text x="${+mx+5}" y="${+labelY-3}" font-size="9" fill="#ff7043">${labelTxt}</text>
      <text x="${W-pad}" y="${pad+8}" font-size="8" fill="#90a4ae" text-anchor="end">${type}</text>`;
  }

  _hideInspector() {
    if (this._inspPanel) this._inspPanel.classList.add('hidden');
    this._inspElemId = null;
  }

  // �?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?
  // MODAL / DYNAMIC VISUALIZATION
  // �?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?

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

  // ── P2-4: Color legend bar ────────────────────────────────────────────────
  _drawColorbar(minVal, maxVal) {
    const canvas = document.getElementById('colorbar-canvas');
    const wrap   = document.getElementById('colorbar-wrap');
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    // blue → cyan → green → yellow → red  (matches _dispColor)
    grad.addColorStop(0,    '#0000ff');
    grad.addColorStop(0.25, '#00ffff');
    grad.addColorStop(0.5,  '#00ff00');
    grad.addColorStop(0.75, '#ffff00');
    grad.addColorStop(1,    '#ff0000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    wrap.style.display = '';
    document.getElementById('cb-min').textContent = _fmt(minVal);
    document.getElementById('cb-mid').textContent = _fmt((minVal + maxVal) / 2);
    document.getElementById('cb-max').textContent = _fmt(maxVal);
  }

  // ── P2-6: Node / element ID sprites ──────────────────────────────────────
  toggleIds() {
    this._showIds = !this._showIds;
    for (const s of this._idSprites) this._scene.remove(s);
    this._idSprites = [];

    const btn = document.getElementById('btn-toggle-ids');
    if (btn) btn.classList.toggle('active', this._showIds);
    if (!this._showIds) return;

    const model = this.app.model;
    const addSprite = (text, col, pos, scaleX = 0.9) => {
      const sp = this._makeIdSprite(text, col);
      sp.position.copy(pos);
      sp.scale.set(scaleX, 0.38, 1);
      this._scene.add(sp);
      this._idSprites.push(sp);
    };

    // Node IDs — cyan, above node
    for (const [id, mesh] of this._nodeMeshes) {
      addSprite(`N${id}`, '#4fc3f7',
        mesh.position.clone().add(new THREE.Vector3(0, 0.34, 0)));
    }

    // Element IDs — orange, at midpoint offset slightly upward
    for (const [id] of this._elemLines) {
      const elem = model.elements.get(id);
      if (!elem) continue;
      const nA = model.nodes.get(elem.n1 ?? elem.nodeA);
      const nB = model.nodes.get(elem.n2 ?? elem.nodeB);
      if (!nA || !nB) continue;
      const mid = this.m2t(
        (nA.x + nB.x) / 2,
        (nA.y + nB.y) / 2,
        (nA.z + nB.z) / 2
      ).add(new THREE.Vector3(0, 0.22, 0));
      addSprite(`E${id}`, '#ffb74d', mid, 0.82);
    }

    // Diaphragm IDs — purple, at master node (CR) raised higher to avoid overlap
    for (const [id, d] of model.diaphragms) {
      const masterId = d.masterId ?? d.nodes?.[0];
      if (!masterId) continue;
      const master = model.nodes.get(masterId);
      if (!master) continue;
      const pos = this.m2t(master.x, master.y, master.z)
        .add(new THREE.Vector3(0, 0.62, 0));
      addSprite(`Dia${id}`, '#ce93d8', pos, 1.15);
    }
  }

  _makeIdSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 28;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(10,14,26,0.75)';
    ctx.fillRect(0, 0, 64, 28);
    ctx.font = 'bold 14px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, 32, 20);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.9, 0.4, 1);
    return sprite;
  }

  // ── P4-13: Extruded section rendering ─────────────────────────────────────
  toggleExtruded() {
    this._showExtruded = !this._showExtruded;
    const btn = document.getElementById('btn-toggle-extrude');
    if (btn) btn.classList.toggle('active', this._showExtruded);

    // Remove previous extrusions
    for (const obj of (this._extrudedObjects || [])) this._scene.remove(obj);
    this._extrudedObjects = [];

    // Restore line visibility
    for (const [, line] of this._elemLines) line.visible = true;

    if (!this._showExtruded) {
      if (this._extrusionLight) this._extrusionLight.visible = false;
      return;
    }

    // Add directional light for 3D shading
    if (!this._extrusionLight) {
      this._extrusionLight = new THREE.DirectionalLight(0xffffff, 0.8);
      this._extrusionLight.position.set(10, 20, 10);
      this._scene.add(this._extrusionLight);
    }
    this._extrusionLight.visible = true;

    const model = this.app.model;
    for (const elem of model.elements.values()) {
      const n1  = model.nodes.get(elem.n1);
      const n2  = model.nodes.get(elem.n2);
      const sec = model.sections.get(elem.secId);
      if (!n1 || !n2 || !sec) continue;

      // Estimate rectangular b×h from A and Iz:  h=sqrt(12*Iz/A), b=A/h
      const A  = sec.A  || 0.09;
      const Iz = sec.Iz || 6.75e-4;
      const h  = Math.sqrt(12 * Iz / A) || 0.3;
      const b  = A / h;

      const shape = new THREE.Shape();
      shape.moveTo(-b / 2, -h / 2);
      shape.lineTo( b / 2, -h / 2);
      shape.lineTo( b / 2,  h / 2);
      shape.lineTo(-b / 2,  h / 2);
      shape.closePath();

      // Element length
      const dx = n2.x - n1.x, dy = n2.y - n1.y, dz = n2.z - n1.z;
      const L  = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (L < 1e-9) continue;

      const geo = new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false });
      const mat = new THREE.MeshPhongMaterial({
        color: 0x90caf9, transparent: true, opacity: 0.75, side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geo, mat);

      // Orient mesh so ExtrudeGeometry +Z points along the element axis
      const axis = new THREE.Vector3(dx / L, dz / L, dy / L); // model→Three.js
      const ref  = Math.abs(axis.y) < 0.99
        ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const side = new THREE.Vector3().crossVectors(axis, ref).normalize();
      const up   = new THREE.Vector3().crossVectors(side, axis).normalize();
      const rm   = new THREE.Matrix4().makeBasis(side, up, axis);
      mesh.applyMatrix4(rm);
      mesh.position.copy(this.m2t(n1.x, n1.y, n1.z));

      this._scene.add(mesh);
      this._extrudedObjects.push(mesh);

      // Dim the wire
      const line = this._elemLines.get(elem.id);
      if (line) line.visible = false;
    }
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

