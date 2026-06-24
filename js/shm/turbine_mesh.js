// ─────────────────────────────────────────────────────────────────────────────
// turbine_mesh.js — malla 3D «linda» de una torre eólica (wind-shm).
//
// Devuelve un THREE.Group con: fuste cónico + góndola + buje + 3 aspas (rotor que
// gira) + 2 sensores MEMS (tope/centro) y un gateway parpadeantes («capa de vida»).
//
// Las geometrías se comparten entre torres (baratas); los MATERIALES del cuerpo se
// CLONAN por torre para poder atenuar las no seleccionadas. A escala de flota (~100)
// migraremos a InstancedMesh + atenuación por shader (ver docs/wind-shm-issues.md).
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

export const TOWER_H = 90;          // altura de buje (m), coherente con el macromodelo

// ── Geometrías compartidas ───────────────────────────────────────────────────
const mastGeo    = new THREE.CylinderGeometry(1.5, 2.2, TOWER_H, 28, 1, false);
const nacelleGeo = new THREE.BoxGeometry(3.2, 3.0, 7.5);
const hubGeo     = new THREE.SphereGeometry(1.5, 20, 16);
const noseGeo    = new THREE.ConeGeometry(1.45, 2.6, 22);
const sensorGeo  = new THREE.SphereGeometry(0.95, 16, 12);
const gatewayGeo = new THREE.BoxGeometry(2.4, 2.0, 2.4);

// Aspa: perfil cónico con punta redondeada, extruido fino.
function makeBladeGeometry() {
  const L = 42, s = new THREE.Shape();
  s.moveTo(-1.6, 0);                       // borde de ataque (raíz)
  s.lineTo(1.2, 0);                        // borde de fuga (raíz)
  s.lineTo(0.45, L * 0.92);               // borde de fuga → cerca de la punta
  s.quadraticCurveTo(0, L, -0.55, L * 0.92); // punta redondeada
  s.lineTo(-1.6, 0);                       // borde de ataque de vuelta
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.5, bevelEnabled: true, bevelThickness: 0.15, bevelSize: 0.15, bevelSegments: 1 });
  g.translate(0, 0, -0.25);                // centrar en Z
  g.computeVertexNormals();
  return g;
}
const bladeGeo = makeBladeGeometry();

// ── Materiales base (se clonan por torre para el cuerpo) ──────────────────────
const baseMats = {
  tower:   new THREE.MeshStandardMaterial({ color: 0xf3f4f6, metalness: 0.15, roughness: 0.55 }),
  nacelle: new THREE.MeshStandardMaterial({ color: 0xdde3ea, metalness: 0.25, roughness: 0.5 }),
  hub:     new THREE.MeshStandardMaterial({ color: 0xc2c8cf, metalness: 0.3,  roughness: 0.5 }),
  blade:   new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.05, roughness: 0.6 }),
};

let _uid = 0;

/**
 * Crea una torre eólica completa y animable.
 * @param {object} o { id?, yaw?, spin? }
 * @returns objeto con { group, rotor, sensors[], gateway, bodyMats[], spin, id }
 */
export function createTurbine(o = {}) {
  const id = o.id ?? `WT-${String(++_uid).padStart(2, '0')}`;
  const yaw = o.yaw ?? (Math.random() * Math.PI * 2);
  const spin = o.spin ?? (1.1 + Math.random() * 0.6);    // rad/s, leve variación por torre

  const group = new THREE.Group();
  group.userData.turbineId = id;

  const bodyMats = [baseMats.tower.clone(), baseMats.nacelle.clone(), baseMats.hub.clone(), baseMats.blade.clone()];
  const [mTower, mNacelle, mHub, mBlade] = bodyMats;

  // Fuste
  const mast = new THREE.Mesh(mastGeo, mTower);
  mast.position.y = TOWER_H / 2; mast.castShadow = true; mast.userData.turbineId = id;
  group.add(mast);

  // Conjunto superior (góndola + rotor) — gira en azimut (yaw)
  const top = new THREE.Group();
  top.position.y = TOWER_H; top.rotation.y = yaw;
  group.add(top);

  const nacelle = new THREE.Mesh(nacelleGeo, mNacelle);
  nacelle.position.set(0, 1.4, -1.0); nacelle.castShadow = true;
  top.add(nacelle);

  // Rotor (buje + nariz + 3 aspas) — gira sobre su eje Z local
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.4, 3.4);
  top.add(rotor);

  const hub = new THREE.Mesh(hubGeo, mHub); hub.castShadow = true; rotor.add(hub);
  const nose = new THREE.Mesh(noseGeo, mHub);
  nose.rotation.x = Math.PI / 2; nose.position.z = 1.6; rotor.add(nose);

  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(bladeGeo, mBlade);
    blade.rotation.z = (i * 2 * Math.PI) / 3;
    blade.castShadow = true; blade.userData.turbineId = id;
    rotor.add(blade);
  }

  // ── Capa de vida: 2 sensores MEMS + gateway (materiales propios, parpadean) ──
  const mkLive = (color) => new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: color, emissiveIntensity: 1, roughness: 0.4 });
  const sensors = [];
  for (const [tag, hy] of [['acc-top', 0.93], ['acc-mid', 0.5]]) {
    const m = mkLive(0x33ff88);
    const s = new THREE.Mesh(sensorGeo, m);
    const r = THREE.MathUtils.lerp(2.2, 1.5, hy);     // radio del fuste a esa altura
    s.position.set(r + 0.3, TOWER_H * hy, 0);
    s.userData = { turbineId: id, sensor: tag };
    group.add(s); sensors.push({ mesh: s, mat: m, tag, phase: Math.random() * 6.28 });
  }
  const gMat = mkLive(0x35a7ff);
  const gw = new THREE.Mesh(gatewayGeo, gMat);
  gw.position.set(4.5, 1.0, 4.5); gw.castShadow = true; gw.userData = { turbineId: id, gateway: true };
  group.add(gw);
  const gateway = { mesh: gw, mat: gMat, phase: Math.random() * 6.28 };

  return { id, group, rotor, sensors, gateway, bodyMats, spin };
}
