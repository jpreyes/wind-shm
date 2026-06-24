// ─────────────────────────────────────────────────────────────────────────────
// structures.js — estructuras del parque (ReWind):
//   · fundación circular típica de aerogenerador,
//   · torre de alta tensión de CELOSÍA modelada MIEMBRO A MIEMBRO (no macromodelo:
//     patas + montantes + diagonales + ménsulas, como un reticulado real),
//   · cables de conexión por el suelo.
// Los miembros se dibujan con un cilindro unitario reescalado (1 geometría).
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 6);
const _up = new THREE.Vector3(0, 1, 0);

// Un miembro estructural entre dos puntos (cilindro reescalado).
export function member(a, b, r, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length() || 1e-6;
  const m = new THREE.Mesh(UNIT_CYL, mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(_up, dir.clone().normalize());
  m.scale.set(r, len, r);
  return m;
}

const steelMat    = new THREE.MeshStandardMaterial({ color: 0x7f8c99, metalness: 0.3, roughness: 0.6 });
const concreteMat = new THREE.MeshStandardMaterial({ color: 0xc4c8cd, metalness: 0, roughness: 0.95 });
export const cableMat = new THREE.MeshStandardMaterial({ color: 0x2c3742, metalness: 0.1, roughness: 0.8 });

let _hvId = 0;

// Fundación circular típica de aerogenerador (losa de hormigón).
export function circularFoundation(radius = 9) {
  const g = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.05, 1.0, 36), concreteMat);
  g.position.y = 0.5; g.receiveShadow = true;
  return g;
}

// Sensor «chillón» (bien visible) para las estructuras de la subestación.
function sensorDot(color = 0x2bff77) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: color, emissiveIntensity: 1.4, roughness: 0.35 });
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), mat);
  return { mesh: s, mat };
}

/**
 * Torre de alta tensión de celosía, modelada miembro a miembro (reticulado).
 * @param {object} o { H, base, top, panels }
 * @returns { group, sensors[] , topY }
 */
export function createSubstationTower(o = {}) {
  const H = o.H ?? 46, base = o.base ?? 6.5, top = o.top ?? 2.2, panels = o.panels ?? 4;
  const id = `HV-${String(++_hvId).padStart(2, '0')}`;
  const group = new THREE.Group();
  group.userData.turbineId = id;            // reutiliza el picking de la flota

  // Nodos de las 4 patas por nivel.
  const lvl = [];
  for (let k = 0; k <= panels; k++) {
    const w = THREE.MathUtils.lerp(base, top, k / panels);
    const y = (H * k) / panels;
    lvl.push([
      new THREE.Vector3(w, y, w), new THREE.Vector3(w, y, -w),
      new THREE.Vector3(-w, y, -w), new THREE.Vector3(-w, y, w),
    ]);
  }
  const add = (a, b, r) => group.add(member(a, b, r, steelMat));
  // Patas + montantes horizontales + diagonales por cara y panel.
  for (let i = 0; i < 4; i++) add(lvl[0][i], lvl[0][(i + 1) % 4], 0.18);   // base
  for (let k = 0; k < panels; k++) {
    for (let i = 0; i < 4; i++) {
      add(lvl[k][i], lvl[k + 1][i], 0.26);                                  // pata
      add(lvl[k + 1][i], lvl[k + 1][(i + 1) % 4], 0.18);                    // horizontal
      add(lvl[k][i], lvl[k + 1][(i + 1) % 4], 0.13);                        // diagonal
    }
  }
  // Ménsulas (cross-arms) para los conductores, a dos alturas.
  const topW = top;
  for (const [yf, len] of [[0.82, 9], [0.97, 7]]) {
    const y = H * yf;
    for (const sgn of [1, -1]) {
      const root = new THREE.Vector3(sgn * topW, y, 0);
      const tip = new THREE.Vector3(sgn * (topW + len), y, 0);
      group.add(member(root, tip, 0.16, steelMat));
      group.add(member(new THREE.Vector3(sgn * topW, y - 4, 0), tip, 0.11, steelMat));  // tornapunta
      // aislador colgante
      group.add(member(tip, tip.clone().setY(y - 2.2), 0.09, steelMat));
    }
  }

  // 4 sensores bien visibles: 2 arriba, 1 medio, 1 en ménsula.
  const sensors = [];
  const place = (v) => { const s = sensorDot(0x2bff77); s.mesh.position.copy(v); s.mesh.userData = { turbineId: id }; group.add(s.mesh); sensors.push({ id: `s${sensors.length + 1}`, ...s, phase: Math.random() * 6.28, status: 'ok' }); };
  place(lvl[panels][0].clone().add(new THREE.Vector3(0.4, 0.4, 0.4)));
  place(lvl[panels][2].clone().add(new THREE.Vector3(-0.4, 0.4, -0.4)));
  place(new THREE.Vector3(base * 0.55, H * 0.45, base * 0.55));
  place(new THREE.Vector3(topW + 8.5, H * 0.82, 0));

  return { id, type: 'hv', label: `Torre AT ${id}`, height: H, group, sensors, topY: H };
}

// Cable de conexión por el suelo (cilindro oscuro, leve curva).
export function groundCable(a, b, y = 0.7) {
  const A = new THREE.Vector3(a.x, y, a.z), B = new THREE.Vector3(b.x, y, b.z);
  return member(A, B, 0.35, cableMat);
}

// Conductor aéreo entre dos torres de alta tensión (catenaria simple).
export function overheadLine(a, b) {
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5); mid.y -= 4;
  const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
  const geo = new THREE.TubeGeometry(curve, 18, 0.18, 5, false);
  return new THREE.Mesh(geo, cableMat);
}
