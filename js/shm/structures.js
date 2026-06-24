// ─────────────────────────────────────────────────────────────────────────────
// structures.js — estructuras del parque (ReWind):
//   · fundación circular típica de aerogenerador,
//   · torre de alta tensión de CELOSÍA modelada MIEMBRO A MIEMBRO (no macromodelo:
//     patas + montantes + diagonales + ménsulas, como un reticulado real),
//   · cables de conexión por el suelo.
// Los miembros se dibujan con un cilindro unitario reescalado (1 geometría).
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { generarTorre } from '../../asistente/generador.js?v=203';

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
export const cableMat = new THREE.MeshStandardMaterial({ color: 0x9aa6b3, metalness: 0.05, roughness: 0.85, transparent: true, opacity: 0.5 });

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
  const H = o.H ?? 42, base = o.base ?? 7, top = o.top ?? 2.5, panels = o.panels ?? 7;
  const id = `HV-${String(++_hvId).padStart(2, '0')}`;
  const group = new THREE.Group();
  group.userData.turbineId = id;            // reutiliza el picking de la flota

  // Geometría REAL desde el generador de torres de transmisión de PÓRTICO
  // (celosía 3D: 4 patas cónicas + anillos + X por cara + crucetas). Nodos/barras FE.
  const ficha = { torre: { altura_m: H, base_m: base, cima_m: top, paneles: panels, rotulado: true,
    crucetas: [{ z_m: H * 0.78, largo_m: base }, { z_m: H * 0.94, largo_m: base * 0.75 }] } };
  const model = generarTorre(ficha, { materiales: [], perfiles: [] });

  const mat = steelMat.clone();             // material propio → permite atenuar la torre
  const pos = new Map();                     // id nodo → posición three (model x,y,z → three x,z,y)
  for (const n of model.nodes) pos.set(n.id, new THREE.Vector3(n.x, n.z, n.y));
  for (const el of model.elements) {
    const a = pos.get(el.n1), b = pos.get(el.n2);
    if (a && b) group.add(member(a, b, el.secId === 1 ? 0.22 : 0.12, mat));   // montante grueso / diagonal fino
  }

  // 4 sensores bien visibles en nodos representativos (2 arriba, 1 medio, 1 en cruceta).
  const ns = model.nodes;
  const topZ = Math.max(...ns.map(n => n.z));
  const tops = ns.filter(n => Math.abs(n.z - topZ) < 0.01);
  const mid = ns.reduce((b, n) => Math.abs(n.z - H / 2) < Math.abs(b.z - H / 2) ? n : b, ns[0]);
  const armTip = ns.reduce((b, n) => Math.abs(n.x) > Math.abs(b.x) ? n : b, ns[0]);
  const picks = [tops[0], tops[2] || tops[1] || tops[0], mid, armTip];
  const sensors = [];
  for (const n of picks) {
    const s = sensorDot(0x2bff77);
    s.mesh.position.copy(pos.get(n.id)).add(new THREE.Vector3(0, 0.6, 0));
    s.mesh.userData = { turbineId: id };
    group.add(s.mesh);
    sensors.push({ id: `s${sensors.length + 1}`, ...s, phase: Math.random() * 6.28, status: 'ok' });
  }

  return { id, type: 'hv', label: `Torre AT ${id}`, height: H, group, sensors, dimMats: [mat], topY: H };
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
