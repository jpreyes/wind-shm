// ─────────────────────────────────────────────────────────────────────────────
// fleet_view.js — escena Three.js del parque eólico (wind-shm).
//
// Gestiona la flota de torres: escena, cámara, controles, luces, suelo y el bucle
// de animación (rotores girando + capa de vida parpadeando). Selección con zoom
// cinematográfico (las demás torres se atenúan). API: addTurbine(), selectTurbine().
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createTurbine, TOWER_H } from './turbine_mesh.js?v=199';
import { createSubstationTower, groundCable, overheadLine } from './structures.js?v=199';

const SPACING = 235;

// Dispersión pseudo-aleatoria pero determinista (estable entre re-layouts).
function jitter(n, seed) { const v = Math.sin(n * seed) * 43758.5453; return (v - Math.floor(v) - 0.5); }

// Lee una variable CSS de tema de PÓRTICO como color hex (#rrggbb).
function cssColor(name, fallback) {
  try {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return new THREE.Color(v || fallback);
  } catch { return new THREE.Color(fallback); }
}

export class FleetView {
  constructor(container) {
    this.container = container;
    this.turbines = [];
    this.structures = [];            // turbinas + torres AT (todo lo seleccionable)
    this.selected = null;
    this._focusing = false;
    this.paused = false;             // animación de aspas (toggle)
    this._intro = null;              // animación de entrada (fly-in)
    this.substation = null;          // { towers[], sensors[] }
    this.cables = [];                 // mallas de cable (recomponibles)
    this.editMode = false;           // modo edición: arrastrar estructuras
    this._drag = null;
    this.onChange = null;            // callback(count) para la UI
    this.onLayoutChange = null;      // callback() al mover/agregar (persistir orden)

    const w = container.clientWidth, h = container.clientHeight;
    this.scene = new THREE.Scene();
    // Fondo igual que el PÓRTICO original (toma el color del tema activo).
    this.scene.background = cssColor('--bg', '#070a0f');

    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 8000);
    this.camera.position.set(220, 150, 320);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, TOWER_H * 0.4, 0);
    this.controls.maxPolarAngle = Math.PI * 0.495;   // no bajar del horizonte

    this._lights();
    this._ground();

    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this._bind();
    this._animate();
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xeaf3fb, 0x9aa7b5, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(250, 350, 180);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xcfe4f5, 0.6);
    fill.position.set(-200, 160, -180);
    this.scene.add(fill);
  }

  // Sin suelo ni cielo: solo la grilla del PÓRTICO original (color del tema).
  _ground() {
    const line = cssColor('--border2', '#2d3a4d');
    const grid = new THREE.GridHelper(6000, 60, line, line);
    grid.material.opacity = 0.35; grid.material.transparent = true;
    this.scene.add(grid);
  }

  // Posición en una grilla dispersa centrada (con jitter determinista).
  _slot(i) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(this.turbines.length + 1)));
    const r = Math.floor(i / cols), c = i % cols;
    const off = (cols - 1) / 2;
    const jx = jitter(i + 1, 12.9898) * SPACING * 0.4;
    const jz = jitter(i + 1, 78.233) * SPACING * 0.4;
    return new THREE.Vector3((c - off) * SPACING + jx, 0, (r - off) * SPACING + jz);
  }

  /** Agrega una torre al parque y la coloca en la grilla. */
  addTurbine(opts = {}) {
    const t = createTurbine(opts);
    t.dim = 0;                       // 0 = nítida, 1 = atenuada
    t.group.position.copy(opts.pos ? new THREE.Vector3(opts.pos.x, 0, opts.pos.z) : this._slot(this.turbines.length));
    this.turbines.push(t);
    this.structures.push(t);
    this.scene.add(t.group);
    this.onChange?.(this.turbines.length);
    this.onLayoutChange?.();
    return t;
  }

  // Re-centra la grilla al cambiar el número de torres.
  _relayout() {
    this.turbines.forEach((t, i) => {
      const p = this._slot(i);
      t.group.position.x = p.x; t.group.position.z = p.z;
    });
  }

  selectTurbine(t) {
    this.selected = t || null;
    this._focusing = !!t;
    this.onSelect?.(t || null);
  }
  clearSelection() { this.selectTurbine(null); this.frameGeneral(); }

  // Catálogo de estructuras (para la lista de la barra lateral).
  getStructures() { return this.structures.map(s => ({ id: s.id, type: s.type, label: s.label, height: s.height })); }
  getStructure(id) { return this.structures.find(s => s.id === id) || null; }
  selectById(id) { const o = this.getStructure(id); if (o) this.selectTurbine(o); }
  setSensorStatus(structId, sensorId, status) {
    const st = this.getStructure(structId); if (!st) return;
    const se = st.sensors.find(x => x.id === sensorId); if (se) se.status = status;
  }

  // ── Encuadre / animación de entrada ───────────────────────────────────────
  setPaused(p) { this.paused = !!p; }

  // Extensión de la flota (centro y radio en planta).
  _extent() {
    const box = new THREE.Box3();
    if (this.turbines.length) for (const t of this.turbines) box.expandByPoint(t.group.position);
    else box.expandByPoint(new THREE.Vector3());
    if (this.substation) for (const hv of this.substation.towers) box.expandByPoint(hv.group.position);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    return { center: c, radius: Math.max(s.x, s.z) / 2 + SPACING };
  }

  // Posición de cámara que encuadra toda la flota, centrada.
  frame() {
    const { center, radius } = this._extent();
    const tgt = new THREE.Vector3(center.x, TOWER_H * 0.45, center.z);
    const dist = Math.max(radius * 2.0, 280);
    const pos = new THREE.Vector3(center.x + dist * 0.45, TOWER_H * 1.15 + radius * 0.4, center.z + dist);
    return { pos, tgt };
  }

  // Vuela suavemente desde la cámara actual hacia (pos, tgt).
  flyTo(pos, tgt, dur = 1400) {
    this._focusing = false;
    this._intro = { t0: performance.now(), dur,
      from: { pos: this.camera.position.clone(), tgt: this.controls.target.clone() },
      to:   { pos: pos.clone(), tgt: tgt.clone() } };
  }
  frameGeneral() { const f = this.frame(); this.flyTo(f.pos, f.tgt, 1300); }

  // Subestación: 2 torres de alta tensión (celosía PÓRTICO) + cables.
  buildSubstation() {
    if (this.substation) return;
    const { center, radius } = this._extent();
    const zsub = center.z + radius + 320;
    this.substation = { towers: [], sensors: [] };
    for (const x of [center.x - 55, center.x + 55]) {
      const hv = createSubstationTower({});
      hv.group.position.set(x, 0, zsub); hv.dim = 0;
      this.scene.add(hv.group);
      this.substation.towers.push(hv);
      this.substation.sensors.push(...hv.sensors);
      this.structures.push(hv);
    }
    this.rebuildCables();
    this.frameGeneral();
  }

  // Agrega una torre de alta tensión a la subestación.
  addHVTower() {
    if (!this.substation) { this.buildSubstation(); return this.substation.towers[0]; }
    const tw = this.substation.towers;
    const zsub = tw[0].group.position.z;
    const x = tw[tw.length - 1].group.position.x + 60;
    const hv = createSubstationTower({});
    hv.group.position.set(x, 0, zsub); hv.dim = 0;
    this.scene.add(hv.group);
    tw.push(hv); this.substation.sensors.push(...hv.sensors); this.structures.push(hv);
    this.rebuildCables();
    this.onChange?.();
    this.onLayoutChange?.();
    return hv;
  }

  // (Re)construye cables: conductores aéreos entre torres HV + cadena colectora
  // de turbinas con un ÚNICO alimentador a la subestación.
  rebuildCables() {
    if (!this.substation) return;
    for (const c of this.cables) { this.scene.remove(c); c.geometry?.dispose?.(); }
    this.cables = [];
    const addC = (m) => { this.scene.add(m); this.cables.push(m); };
    const tw = this.substation.towers;
    const hubs = tw.map(hv => new THREE.Vector3(hv.group.position.x, 1, hv.group.position.z));
    // conductores aéreos entre torres HV consecutivas
    for (let i = 0; i < tw.length - 1; i++) {
      const a = tw[i].group.position, b = tw[i + 1].group.position, y = (tw[i].topY || 40) * 0.9;
      addC(overheadLine(new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(b.x, y, b.z)));
    }
    // cadena colectora + alimentador único
    const pts = this.turbines.map(t => t.group.position.clone());
    if (pts.length) {
      const dHub = (i) => Math.min(...hubs.map(h => pts[i].distanceTo(h)));
      const rest = pts.map((_, i) => i);
      let start = rest.reduce((b, i) => dHub(i) < dHub(b) ? i : b, rest[0]);
      const order = [start]; rest.splice(rest.indexOf(start), 1);
      while (rest.length) {
        const last = order[order.length - 1];
        const n = rest.reduce((b, i) => pts[i].distanceTo(pts[last]) < pts[b].distanceTo(pts[last]) ? i : b, rest[0]);
        order.push(n); rest.splice(rest.indexOf(n), 1);
      }
      const hub = hubs.reduce((b, h) => h.distanceTo(pts[order[0]]) < b.distanceTo(pts[order[0]]) ? h : b, hubs[0]);
      addC(groundCable(hub, pts[order[0]]));
      for (let k = 0; k < order.length - 1; k++) addC(groundCable(pts[order[k]], pts[order[k + 1]]));
    }
  }

  setEditMode(b) { this.editMode = !!b; this.renderer.domElement.style.cursor = b ? 'move' : ''; if (!b) this._drag = null; }

  // Animación de entrada: barrido aéreo que desciende sobre el parque.
  playIntro() {
    const f = this.frame();
    this.camera.position.set(f.tgt.x, f.pos.y * 2.2 + 520, f.pos.z + 620);
    this.controls.target.copy(f.tgt);
    this.flyTo(f.pos, f.tgt, 3000);
  }

  _bind() {
    addEventListener('resize', () => {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    let downXY = null;
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', e => {
      downXY = [e.clientX, e.clientY];
      if (this.editMode) {
        const o = this._pickStructure(e);
        if (o) { this._drag = { o }; this.controls.enabled = false; }
      }
    });
    dom.addEventListener('pointermove', e => {
      if (this._drag) { const p = this._groundPoint(e); if (p) { this._drag.o.group.position.x = p.x; this._drag.o.group.position.z = p.z; this.rebuildCables(); } }
    });
    dom.addEventListener('pointerup', e => {
      if (this._drag) { this._drag = null; this.controls.enabled = true; this.rebuildCables(); this.onLayoutChange?.(); downXY = null; return; }
      if (!downXY) return;
      const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
      downXY = null;
      if (moved > 5) return;          // fue un arrastre (orbitar), no un clic
      this._pick(e);
    });
  }

  _ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  _pickStructure(e) {
    this.raycaster.setFromCamera(this._ndc(e), this.camera);
    const hits = this.raycaster.intersectObjects(this.structures.map(s => s.group), true);
    return hits.length ? this.getStructure(hits[0].object.userData.turbineId) : null;
  }
  _groundPoint(e) {
    this.raycaster.setFromCamera(this._ndc(e), this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), out) ? out : null;
  }
  _pick(e) {
    const o = this._pickStructure(e);
    if (!o) { this.clearSelection(); return; }
    if (o === this.selected) this.clearSelection(); else this.selectTurbine(o);
  }

  _animate = () => {
    requestAnimationFrame(this._animate);
    const dt = Math.min(this.clock.getDelta(), 0.05), tt = this.clock.elapsedTime;

    for (const t of this.turbines) {
      if (!this.paused) t.rotor.rotation.z += t.spin * dt;
      // Gateway: siempre encendido (indica que la torre transmite)
      t.gateway.mat.emissiveIntensity = 0.6 + 1.0 * (0.5 + 0.5 * Math.sin(tt * 1.6 + t.gateway.phase));
    }

    // Resalte: la seleccionada queda nítida, TODAS las demás se atenúan (cuerpo, no sensores)
    for (const st of this.structures) {
      const target = (this.selected && st !== this.selected) ? 1 : 0;
      st.dim = (st.dim || 0) + (target - (st.dim || 0)) * Math.min(dt * 4, 1);
      const op = 1 - 0.82 * st.dim;
      for (const mat of (st.dimMats || st.bodyMats || [])) { mat.transparent = st.dim > 0.01; mat.opacity = op; }
    }

    // TODOS los sensores parpadean SIEMPRE — verde=OK, rojo=falla (vistazo de salud)
    const GREEN = 0x2bff77, RED = 0xff3b3b;
    for (const st of this.structures) for (const s of st.sensors) {
      const fault = s.status === 'fault';
      s.mat.emissive.setHex(fault ? RED : GREEN);
      s.mat.emissiveIntensity = 0.5 + 1.1 * (0.5 + 0.5 * Math.sin(tt * (fault ? 5.5 : 3.2) + s.phase));
    }

    // Animación de entrada / vuelo general (con easing)
    if (this._intro) {
      const s = Math.min((performance.now() - this._intro.t0) / this._intro.dur, 1);
      const e = s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;   // easeInOutCubic
      this.camera.position.lerpVectors(this._intro.from.pos, this._intro.to.pos, e);
      this.controls.target.lerpVectors(this._intro.from.tgt, this._intro.to.tgt, e);
      if (s >= 1) this._intro = null;
    }
    // Zoom cinematográfico hacia la torre seleccionada
    else if (this._focusing && this.selected) {
      const p = this.selected.group.position;
      const h = this.selected.height || TOWER_H;
      const tgt = new THREE.Vector3(p.x, h * 0.55, p.z);
      const desired = new THREE.Vector3(p.x + 0.8 * h, h * 0.9, p.z + 1.25 * h);
      this.controls.target.lerp(tgt, dt * 2.5);
      this.camera.position.lerp(desired, dt * 2.5);
      if (this.camera.position.distanceTo(desired) < 4) this._focusing = false;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
