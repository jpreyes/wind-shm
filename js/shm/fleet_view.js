// ─────────────────────────────────────────────────────────────────────────────
// fleet_view.js — escena Three.js del parque eólico (wind-shm).
//
// Gestiona la flota de torres: escena, cámara, controles, luces, suelo y el bucle
// de animación (rotores girando + capa de vida parpadeando). Selección con zoom
// cinematográfico (las demás torres se atenúan). API: addTurbine(), selectTurbine().
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createTurbine, TOWER_H } from './turbine_mesh.js?v=214';
import { createSubstationTower, groundCable, overheadLine } from './structures.js?v=214';
import { toScene } from './parks_data_caman.js?v=214';
import { CAMAN_ROADS } from './caman_roads.js?v=214';

const SPACING = 235;
const TOWER_SCALE = 2.2;   // agranda las torres (vista esquemática) para que destaquen sobre el relieve

// Dispersión pseudo-aleatoria pero determinista (estable entre re-layouts).
function jitter(n, seed) { const v = Math.sin(n * seed) * 43758.5453; return (v - Math.floor(v) - 0.5); }

// Etiqueta de texto (sprite) que flota sobre la estructura — siempre mira a cámara.
function makeLabelSprite(text) {
  const fs = 52, pad = 14, c = document.createElement('canvas');
  let g = c.getContext('2d');
  g.font = `bold ${fs}px Inter, system-ui, sans-serif`;
  c.width = Math.ceil(g.measureText(text).width) + pad * 2; c.height = fs + pad * 2;
  g = c.getContext('2d');
  g.font = `bold ${fs}px Inter, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(15,20,28,0.8)';
  if (g.roundRect) { g.beginPath(); g.roundRect(0, 0, c.width, c.height, 16); g.fill(); } else g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#e6edf3'; g.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const Hworld = 9; sp.scale.set((c.width / c.height) * Hworld, Hworld, 1);
  sp.renderOrder = 20;
  return sp;
}

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
    this.zoneFilterIds = null;       // Set<id> de la zona enfocada (null = todo el parque)
    this.onChange = null;            // callback(count) para la UI
    this.onLayoutChange = null;      // callback() al mover/agregar (persistir orden)

    const w = container.clientWidth, h = container.clientHeight;
    this.scene = new THREE.Scene();
    // Fondo igual que el PÓRTICO original (toma el color del tema activo).
    this.scene.background = cssColor('--bg', '#070a0f');

    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 32000);   // far amplio: Camán I + grid de ~24k en escena
    this.camera.position.set(220, 150, 320);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;   // planos de corte por material (avance 4D)
    container.appendChild(this.renderer.domElement);
    this.constructionMode = true;                 // 4D: torres «llenándose» según su avance

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, TOWER_H * 0.4, 0);
    this.controls.maxPolarAngle = Math.PI * 0.495;   // no bajar del horizonte

    this._lights();
    this._ground();
    this._buildRoads();
    this._buildWind();

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
    const grid = new THREE.GridHelper(24000, 80, line, line);   // área amplia, celdas grandes (~300 u, ×3 del espaciado anterior)
    grid.material.opacity = 0.28; grid.material.transparent = true;
    this.scene.add(grid);
    this.grid = grid;            // se oculta al activar el relieve
  }

  // ── Relieve conceptual (capa de terreno) ─────────────────────────────────────
  // Carga el DEM vendorizado y añade la malla (oculta hasta activarla).
  async loadTerrain(url) {
    const { Terrain } = await import('./terrain.js?v=214');
    const dem = await (await fetch(url)).json();
    this.terrain = new Terrain(dem, { vex: 1.5 });   // relieve exagerado (esquemático)
    this.scene.add(this.terrain.mesh);
    this.terrainOn = true;
    this.applyElevation();                            // las torres SIEMPRE quedan a la cota
    return this.terrain;
  }

  // Apoya todas las estructuras (y cables/caminos) sobre la cota del terreno.
  // Se llama una vez al cargar el relieve; la elevación NO depende de su visibilidad.
  applyElevation() {
    for (const st of this.structures) {
      st.group.position.y = this.groundY(st.group.position.x, st.group.position.z);
      this.setProgress(st.id, st.built);     // los planos de corte dependen de la cota base
    }
    this.rebuildCables();
    this._buildRoads();
  }

  // Muestra/oculta SOLO la malla del relieve; las torres quedan elevadas siempre.
  setTerrainVisible(on) {
    this.terrainOn = !!on && !!this.terrain;
    if (this.terrain) this.terrain.mesh.visible = this.terrainOn;
    if (this.grid) this.grid.visible = true;   // el grid genérico queda siempre (el relieve se asienta encima; no se ve «pelao»)
  }

  // Cota del terreno en (x,z) si está cargado (independiente de su visibilidad).
  groundY(x, z) { return this.terrain ? this.terrain.heightAt(x, z) : 0; }

  // Proyecta el tope de una estructura a coordenadas de pantalla (para la ficha flotante).
  anchorScreen(st) {
    if (!st) return null;
    const h = (st.height || TOWER_H) * (st.group.scale.y || 1);
    const p = st.group.position;
    const v = new THREE.Vector3(p.x, p.y + h * 0.92, p.z).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: (v.x * 0.5 + 0.5) * r.width + r.left, y: (-v.y * 0.5 + 0.5) * r.height + r.top, behind: v.z > 1 };
  }

  // Caminos del parque (KMZ): polilíneas drapeadas sobre el terreno (o a ras si plano).
  _buildRoads() {
    if (this.roads) for (const r of this.roads) { this.scene.remove(r); r.geometry.dispose(); }
    this.roads = [];
    // Tubo de color saturado (alto contraste sobre el relieve pálido).
    this._roadMat ||= new THREE.MeshBasicMaterial({ color: 0xff7a1a });
    for (const seg of CAMAN_ROADS) {
      const pts = seg.map(([lo, la]) => { const s = toScene(lo, la); return new THREE.Vector3(s.x, this.groundY(s.x, s.z) + 1.0, s.z); });
      if (pts.length < 2) continue;
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 3, 5, false);
      const tube = new THREE.Mesh(geo, this._roadMat);
      tube.renderOrder = 2; tube.frustumCulled = false;
      this.roads.push(tube); this.scene.add(tube);
    }
  }

  // Partículas de viento que cruzan el parque (deriva en +X, reciclan).
  _buildWind() {
    const N = 460, B = 1500, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 2 * B; pos[i * 3 + 1] = 6 + Math.random() * 120; pos[i * 3 + 2] = (Math.random() - 0.5) * 2 * B; }
    const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xaedcf2, size: 1.8, transparent: true, opacity: 0.5, depthWrite: false });
    const pts = new THREE.Points(geom, mat); pts.frustumCulled = false;
    this.scene.add(pts);
    this.wind = { geom, pos, B, speed: 75 };
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
    const t = createTurbine(opts);   // opts.id, opts.label, opts.yaw, opts.spin
    t.dim = 0;                       // 0 = nítida, 1 = atenuada
    if (opts.lat != null) t.lat = opts.lat;     // coordenadas reales (WGS84) si vienen del KMZ
    if (opts.lon != null) t.lon = opts.lon;
    if (opts.built != null) t.built = opts.built;   // avance de obra 4D (0..1)
    if (opts.stages) t.stages = opts.stages;         // etapas de obra (editables)
    t.group.position.copy(opts.pos ? new THREE.Vector3(opts.pos.x, 0, opts.pos.z) : this._slot(this.turbines.length));
    this.turbines.push(t);
    this.structures.push(t);
    this._addLabel(t);
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

  // Anillo de selección en el suelo (se crea una vez y se reposiciona bajo la seleccionada).
  _ensureSelRing() {
    if (this._selRing) return this._selRing;
    const geo = new THREE.RingGeometry(11, 14.5, 56); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(geo, mat);
    ring.renderOrder = 15; ring.visible = false; ring.frustumCulled = false;
    this.scene.add(ring);
    return (this._selRing = ring);
  }

  // Catálogo de estructuras (para la lista de la barra lateral).
  getStructures() { return this.structures.map(s => ({ id: s.id, type: s.type, label: s.label, height: s.height })); }
  getStructure(id) { return this.structures.find(s => s.id === id) || null; }
  selectById(id) { const o = this.getStructure(id); if (o) this.selectTurbine(o); }
  _addLabel(st) { const sp = makeLabelSprite(st.label); sp.position.set(0, 2, 14); st.group.add(sp); st._label = sp; }   // al pie, fuera de la fundación
  // Agranda la estructura (vista esquemática) sin agrandar su etiqueta flotante.
  _applyScale(st, k = TOWER_SCALE) {
    st.group.scale.setScalar(k);
    if (st._label) { st._label.scale.multiplyScalar(1 / k); st._label.position.set(0, 2 / k, 14 / k); }
  }
  // Cambia la etiqueta visible (nombre) de una estructura y reconstruye su sprite 3D.
  setLabel(id, text) {
    const st = this.getStructure(id); if (!st || !text) return;
    st.label = text;
    if (st._label) { st.group.remove(st._label); st._label.material.map?.dispose?.(); st._label.material.dispose?.(); st._label = null; }
    this._addLabel(st);
  }
  setSensorStatus(structId, sensorId, status) {
    const st = this.getStructure(structId); if (!st) return;
    const se = st.sensors.find(x => x.id === sensorId); if (se) se.status = status;
  }

  // Orientación (yaw): gira el cabezal de la turbina (góndola+rotor) o la torre AT.
  setYaw(structId, rad) {
    const st = this.getStructure(structId); if (!st) return;
    if (st.top) st.top.rotation.y = rad; else st.group.rotation.y = rad;
    if (st._ghostHead) st._ghostHead.rotation.y = rad;   // la cabeza fantasma sigue la orientación
    st.yaw = rad;
  }
  getYaw(structId) {
    const st = this.getStructure(structId); if (!st) return 0;
    return st.top ? st.top.rotation.y : (st.group.rotation.y || 0);
  }

  // ── Avance de obra (4D): «llena» la estructura hasta la cota erigida ──────────
  // built ∈ [0,1]: el cuerpo sólido se recorta por debajo de la cota y la silueta
  // fantasma por encima; los sensores por sobre lo erigido se ocultan.
  setProgress(structId, built) {
    const st = this.getStructure(structId); if (!st) return;
    built = Math.max(0, Math.min(1, built ?? st.built ?? 1));
    st.built = built;
    // «Operativa»: turbina con rotor instalado (gira); torre AT cuando está completa.
    const op = st.type === 'turbine' ? built >= 0.97 : built >= 0.999;
    st.operational = st.type === 'turbine' ? op : false;
    if (!this.constructionMode) return;
    const h = (st.height || TOWER_H) * (st.group.scale.y || 1);
    const yCut = st.group.position.y + built * h;
    (st._planeBelow ||= new THREE.Plane()).setComponents(0, -1, 0, yCut);   // conserva y ≤ yCut (lo erigido)
    (st._planeAbove ||= new THREE.Plane()).setComponents(0, 1, 0, -yCut);   // conserva y ≥ yCut (lo que falta)
    for (const m of (st.solidMats || [])) { m.clippingPlanes = [st._planeBelow]; m.clipShadows = true; }
    for (const m of (st.ghost?.mats || [])) m.clippingPlanes = [st._planeAbove];
    for (const gm of (st.ghost?.meshes || [])) gm.visible = !op;   // silueta del fuste/celosía que falta
    if (st.type === 'turbine') {
      if (st._ghostHead) st._ghostHead.visible = !op;   // cabeza fantasma mientras no esté operativa
      if (st.top) st.top.visible = op;                  // cabeza sólida (girando) sólo si operativa
    }
    for (const s of st.sensors) if (s._hfrac != null) s.mesh.visible = built >= s._hfrac;
  }

  // Activa/desactiva el modo construcción (4D). Apagado → torres completas y operativas.
  setConstructionMode(on) {
    this.constructionMode = !!on;
    for (const st of this.structures) {
      if (on) { this.setProgress(st.id, st.built); continue; }
      for (const m of (st.solidMats || [])) m.clippingPlanes = null;
      for (const m of (st.ghost?.mats || [])) m.clippingPlanes = null;
      for (const gm of (st.ghost?.meshes || [])) gm.visible = false;
      if (st._ghostHead) st._ghostHead.visible = false;
      if (st.top) st.top.visible = true;
      if (st.type === 'turbine') st.operational = true;
      for (const s of st.sensors) s.mesh.visible = true;
    }
  }

  // Alarma de emergencia: faro rojo titilante sobre la estructura.
  setAlarm(structId, on) {
    const st = this.getStructure(structId); if (!st || st.alarm === on) return;
    st.alarm = on;
    if (on && !st._beacon) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2a2a, emissiveIntensity: 1.6, transparent: true, opacity: 0.95 });
      const b = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 12), mat);
      b.position.set(0, (st.height || 90) + 9, 0);
      b.userData = { turbineId: structId };
      st.group.add(b); st._beacon = { mesh: b, mat };
    }
    if (st._beacon) st._beacon.mesh.visible = on;
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
    const gy = this.groundY(center.x, center.z), H = TOWER_H * TOWER_SCALE;
    const tgt = new THREE.Vector3(center.x, gy + H * 0.45, center.z);
    const dist = Math.max(radius * 2.0, 280);
    const pos = new THREE.Vector3(center.x + dist * 0.45, gy + H * 1.15 + radius * 0.4, center.z + dist);
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
      this._addLabel(hv);
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
    tw.push(hv); this.substation.sensors.push(...hv.sensors); this.structures.push(hv); this._addLabel(hv);
    this.rebuildCables();
    this.onChange?.();
    this.onLayoutChange?.();
    return hv;
  }

  // Libera SÓLO los materiales clonados por estructura (las geometrías se comparten).
  _disposeStructure(st) {
    this.scene.remove(st.group);
    const mats = [...(st.dimMats || st.bodyMats || []), ...st.sensors.map(s => s.mat)];
    if (st.gateway?.mat) mats.push(st.gateway.mat);
    if (st._beacon?.mat) mats.push(st._beacon.mat);
    if (st.ghost?.mats) mats.push(...st.ghost.mats);
    for (const m of mats) m?.dispose?.();
    if (st._label) { st._label.material.map?.dispose?.(); st._label.material.dispose?.(); }
  }

  /** Elimina una estructura (torre eólica o torre AT) de la flota. */
  removeStructure(id) {
    const st = this.getStructure(id);
    if (!st) return false;
    if (this.selected === st) this.clearSelection();
    this._disposeStructure(st);
    // Saca de los índices.
    this.structures = this.structures.filter(s => s !== st);
    this.turbines = this.turbines.filter(t => t !== st);
    if (this.substation) {
      this.substation.towers = this.substation.towers.filter(t => t !== st);
      this.substation.sensors = this.substation.sensors.filter(se => !st.sensors.includes(se));
    }
    this.rebuildCables();
    this.onChange?.(this.turbines.length);
    this.onLayoutChange?.();
    return true;
  }

  // ── Parques (multiparque): vaciar y reconstruir la flota desde un layout ──────
  // Quita TODAS las estructuras y cables (para cambiar de parque sin fugas de GPU).
  clearAll() {
    this.clearSelection();
    this.zoneFilterIds = null;
    for (const st of this.structures) this._disposeStructure(st);
    for (const c of this.cables) { this.scene.remove(c); c.geometry?.dispose?.(); }
    this.structures = []; this.turbines = []; this.cables = []; this.substation = null;
  }

  // Carga un parque: { turbines:[{x,z,yaw,zone}], hv:[{x,z,yaw,zone}] }. Cada
  // estructura conserva su `zone` (etiqueta de zona) para el árbol lateral.
  loadPark(p) {
    const oc = this.onChange, ol = this.onLayoutChange;   // silencia persistencia durante la reconstrucción
    this.onChange = null; this.onLayoutChange = null;
    this.clearAll();
    for (const t of (p?.turbines || [])) {
      const o = this.addTurbine({ pos: { x: t.x, z: t.z }, id: t.id, label: t.label, lat: t.lat, lon: t.lon, built: t.built, stages: t.stages });
      if (t.yaw != null) this.setYaw(o.id, t.yaw);
      o.zone = t.zone || null;
      this._applyScale(o);
      this.setProgress(o.id, t.built);          // aplica el llenado 4D
    }
    if ((p?.hv || []).length) {
      this.substation = { towers: [], sensors: [] };
      for (const h of p.hv) {
        const hv = createSubstationTower({ id: h.id, label: h.label });
        hv.group.position.set(h.x, 0, h.z); hv.dim = 0;
        if (h.yaw != null) this.setYaw(hv.id, h.yaw);
        if (h.lat != null) hv.lat = h.lat;
        if (h.lon != null) hv.lon = h.lon;
        if (h.built != null) hv.built = h.built;
        if (h.stages) hv.stages = h.stages;
        hv.zone = h.zone || null;
        this.scene.add(hv.group);
        this.substation.towers.push(hv); this.substation.sensors.push(...hv.sensors);
        this.structures.push(hv); this._addLabel(hv);
        this._applyScale(hv);
        this.setProgress(hv.id, h.built);       // aplica el llenado 4D
      }
      this.rebuildCables();
    }
    this.onChange = oc; this.onLayoutChange = ol;
    this.onChange?.(this.turbines.length);
    this.frameGeneral();
  }

  // Enfoca una zona: atenúa lo demás y encuadra sus estructuras (ids = Set | null).
  focusZone(ids) {
    this.zoneFilterIds = (ids && ids.size) ? ids : null;
    if (this.selected) this.clearSelection();
    if (this.zoneFilterIds) this.frameStructs(this.structures.filter(s => this.zoneFilterIds.has(s.id)));
    else this.frameGeneral();
  }

  // Encuadra la cámara sobre un subconjunto de estructuras.
  frameStructs(list) {
    if (!list || !list.length) { this.frameGeneral(); return; }
    const box = new THREE.Box3();
    for (const s of list) box.expandByPoint(s.group.position);
    const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    const radius = Math.max(sz.x, sz.z) / 2 + SPACING;
    const gy = this.groundY(c.x, c.z), H = TOWER_H * TOWER_SCALE;
    const tgt = new THREE.Vector3(c.x, gy + H * 0.45, c.z);
    const dist = Math.max(radius * 2.0, 280);
    const pos = new THREE.Vector3(c.x + dist * 0.45, gy + H * 1.15 + radius * 0.4, c.z + dist);
    this.flyTo(pos, tgt, 1100);
  }

  // (Re)construye cables: conductores aéreos entre torres HV + cadena colectora
  // de turbinas con un ÚNICO alimentador a la subestación.
  rebuildCables() {
    if (!this.substation) return;
    for (const c of this.cables) { this.scene.remove(c); c.geometry?.dispose?.(); }
    this.cables = [];
    const addC = (m) => { this.scene.add(m); this.cables.push(m); };
    const tw = this.substation.towers;
    // Las posiciones ya llevan la cota del terreno en .y (si el relieve está activo).
    const hubs = tw.map(hv => new THREE.Vector3(hv.group.position.x, hv.group.position.y + 1, hv.group.position.z));
    // conductores aéreos entre torres HV consecutivas (siguen la cota de cada torre)
    for (let i = 0; i < tw.length - 1; i++) {
      const a = tw[i].group.position, b = tw[i + 1].group.position, dh = (tw[i].topY || 40) * 0.9;
      addC(overheadLine(new THREE.Vector3(a.x, a.y + dh, a.z), new THREE.Vector3(b.x, b.y + dh, b.z)));
    }
    // cadena colectora + alimentador único (cables a ras, +0.7 sobre el terreno)
    const pts = this.turbines.map(t => { const p = t.group.position.clone(); p.y += 0.7; return p; });
    if (pts.length && hubs.length) {
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
    // El mesh impactado puede ser una barra de celosía o una pieza interna sin
    // `turbineId`; sube por el árbol hasta el grupo de la estructura (así las torres
    // AT — y cualquier sub-malla — quedan seleccionables, movibles y borrables).
    for (let o = hits[0]?.object; o; o = o.parent) {
      const st = o.userData?.turbineId && this.getStructure(o.userData.turbineId);
      if (st) return st;
    }
    return null;
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

    // Viento: deriva las partículas en +X y recíclalas al salir del dominio.
    if (this.wind) {
      const { pos, B, speed, geom } = this.wind;
      for (let i = 0; i < pos.length; i += 3) { pos[i] += speed * dt; if (pos[i] > B) pos[i] -= 2 * B; }
      geom.attributes.position.needsUpdate = true;
    }

    for (const t of this.turbines) {
      if (!this.paused && t.operational !== false) t.rotor.rotation.z += t.spin * dt;   // sólo giran las operativas
      // Gateway: siempre encendido (indica que la torre transmite)
      t.gateway.mat.emissiveIntensity = 0.6 + 1.0 * (0.5 + 0.5 * Math.sin(tt * 1.6 + t.gateway.phase));
    }

    // Resalte: la seleccionada queda nítida, TODAS las demás se atenúan (cuerpo, no sensores)
    const alarmPulse = 0.5 + 0.5 * Math.sin(tt * 8);
    for (const st of this.structures) {
      // atenuación: si hay selección manda la selección; si no, manda la zona enfocada
      let target = 0;
      if (this.selected) target = st === this.selected ? 0 : 1;
      else if (this.zoneFilterIds) target = this.zoneFilterIds.has(st.id) ? 0 : 1;
      st.dim = (st.dim || 0) + (target - (st.dim || 0)) * Math.min(dt * 4, 1);
      const op = 1 - 0.82 * st.dim;
      const rp = st.alarm ? 0.6 * alarmPulse : 0;   // titileo rojo en alarma
      const selGlow = (st === this.selected && !st.alarm) ? (0.55 + 0.25 * Math.sin(tt * 4)) : 0;  // realce azul de la seleccionada
      for (const mat of (st.dimMats || st.bodyMats || [])) {
        mat.transparent = st.dim > 0.01; mat.opacity = op;
        if (mat.emissive) mat.emissive.setRGB(rp, selGlow * 0.45, selGlow);
      }
      // Oscilación leve de la punta por el viento (sway sobre la base, ejes X/Z)
      if (!this.paused) {
        if (st._sw === undefined) st._sw = Math.random() * 6.28;
        const amp = st.type === 'hv' ? 0.0025 : 0.006;
        st.group.rotation.z = amp * Math.sin(tt * 0.9 + st._sw);
        st.group.rotation.x = amp * 0.7 * Math.sin(tt * 0.7 + st._sw * 1.3);
      }
    }

    // TODOS los sensores parpadean SIEMPRE — verde=OK, rojo=falla (vistazo de salud)
    const GREEN = 0x2bff77, RED = 0xff3b3b;
    for (const st of this.structures) for (const s of st.sensors) {
      const fault = s.status === 'fault';
      s.mat.emissive.setHex(fault ? RED : GREEN);
      s.mat.emissiveIntensity = 0.5 + 1.1 * (0.5 + 0.5 * Math.sin(tt * (fault ? 5.5 : 3.2) + s.phase));
    }

    // Faro de emergencia: titileo rápido sobre las estructuras en alarma
    for (const st of this.structures) if (st.alarm && st._beacon) {
      const p = 0.5 + 0.5 * Math.sin(tt * 8);
      st._beacon.mat.emissiveIntensity = 0.5 + 2.2 * p;
      st._beacon.mesh.scale.setScalar(0.75 + 0.55 * p);
    }

    // Anillo de selección: lo posiciona y pulsa bajo la estructura seleccionada.
    const ring = this._ensureSelRing();
    if (this.selected) {
      const p = this.selected.group.position, pulse = 0.5 + 0.5 * Math.sin(tt * 4);
      ring.visible = true;
      ring.position.set(p.x, p.y + 1.2, p.z);                                  // a la cota de la torre
      ring.scale.setScalar((this.selected.type === 'hv' ? 1.15 : 1.3) * TOWER_SCALE * (1 + 0.08 * Math.sin(tt * 4)));
      ring.material.opacity = 0.6 + 0.35 * pulse;
    } else ring.visible = false;

    // Relieve: se oscurece al seleccionar una torre (recede sin volverse blanco).
    if (this.terrain) {
      const u = this.terrain.mesh.material.uniforms.uDim;
      u.value += ((this.selected ? 1.0 : 0.0) - u.value) * Math.min(dt * 4, 1);
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
      const h = (this.selected.height || TOWER_H) * (this.selected.group.scale.y || 1);
      const tgt = new THREE.Vector3(p.x, p.y + h * 0.55, p.z);                       // mira la torre a su cota real
      const desired = new THREE.Vector3(p.x + 0.9 * h, p.y + h * 1.1, p.z + 1.35 * h); // ángulo más picado (evita el relieve)
      this.controls.target.lerp(tgt, dt * 2.5);
      this.camera.position.lerp(desired, dt * 2.5);
      if (this.camera.position.distanceTo(desired) < 4) this._focusing = false;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();          // hook por frame (p. ej. reposicionar la ficha flotante)
  };
}
