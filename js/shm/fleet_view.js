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

const SKY = 0xbcd4e6, SPACING = 130;

export class FleetView {
  constructor(container) {
    this.container = container;
    this.turbines = [];
    this.selected = null;
    this._focusing = false;
    this.onChange = null;            // callback(count) para la UI

    const w = container.clientWidth, h = container.clientHeight;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 500, 3000);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 6000);
    this.camera.position.set(220, 150, 320);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    this.scene.add(new THREE.HemisphereLight(0xcfe3f3, 0x6b7b5e, 0.95));
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.15);
    sun.position.set(250, 350, 180); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera; c.near = 50; c.far = 1400; c.left = -500; c.right = 500; c.top = 500; c.bottom = -500;
    this.scene.add(sun);
  }

  _ground() {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(5000, 5000),
      new THREE.MeshStandardMaterial({ color: 0x8a9a6b, roughness: 1 })
    );
    g.rotation.x = -Math.PI / 2; g.receiveShadow = true;
    this.scene.add(g);
    const grid = new THREE.GridHelper(5000, 80, 0x6f7f57, 0x7c8c63);
    grid.material.opacity = 0.25; grid.material.transparent = true;
    this.scene.add(grid);
  }

  // Posición en una grilla cuadrada centrada.
  _slot(i) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(this.turbines.length + 1)));
    const r = Math.floor(i / cols), c = i % cols;
    const off = (cols - 1) / 2;
    return new THREE.Vector3((c - off) * SPACING, 0, (r - off) * SPACING);
  }

  /** Agrega una torre al parque y la coloca en la grilla. */
  addTurbine(opts = {}) {
    const t = createTurbine(opts);
    t.dim = 0;                       // 0 = nítida, 1 = atenuada
    t.group.position.copy(this._slot(this.turbines.length));
    this.turbines.push(t);
    this.scene.add(t.group);
    this._relayout();
    this.onChange?.(this.turbines.length);
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
  clearSelection() { this.selectTurbine(null); }

  _bind() {
    addEventListener('resize', () => {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    let downXY = null;
    this.renderer.domElement.addEventListener('pointerdown', e => { downXY = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (!downXY) return;
      const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
      downXY = null;
      if (moved > 5) return;          // fue un arrastre (orbitar), no un clic
      this._pick(e);
    });
  }

  _pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(m, this.camera);
    const hits = this.raycaster.intersectObjects(this.turbines.map(t => t.group), true);
    if (!hits.length) { this.clearSelection(); return; }
    const id = hits[0].object.userData.turbineId;
    const t = this.turbines.find(x => x.id === id);
    if (t) this.selectTurbine(t === this.selected ? null : t);
  }

  _animate = () => {
    requestAnimationFrame(this._animate);
    const dt = Math.min(this.clock.getDelta(), 0.05), tt = this.clock.elapsedTime;

    for (const t of this.turbines) {
      t.rotor.rotation.z += t.spin * dt;
      // Atenuación suave de las no seleccionadas
      const target = (this.selected && t !== this.selected) ? 1 : 0;
      t.dim += (target - t.dim) * Math.min(dt * 4, 1);
      const op = 1 - 0.78 * t.dim;
      for (const mat of t.bodyMats) { mat.transparent = t.dim > 0.01; mat.opacity = op; }
      // Capa de vida: parpadeo (latido). Se apaga al atenuar.
      const live = 1 - t.dim;
      for (const s of t.sensors) s.mat.emissiveIntensity = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(tt * 3.2 + s.phase))) * live;
      t.gateway.mat.emissiveIntensity = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(tt * 1.6 + t.gateway.phase))) * live;
    }

    // Zoom cinematográfico hacia la torre seleccionada
    if (this._focusing && this.selected) {
      const p = this.selected.group.position;
      const tgt = new THREE.Vector3(p.x, TOWER_H * 0.55, p.z);
      const desired = new THREE.Vector3(p.x + 70, TOWER_H * 0.8, p.z + 110);
      this.controls.target.lerp(tgt, dt * 2.5);
      this.camera.position.lerp(desired, dt * 2.5);
      if (this.camera.position.distanceTo(desired) < 4) this._focusing = false;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
