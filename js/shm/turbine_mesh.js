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
import { circularFoundation } from './structures.js?v=262';

export const TOWER_H = 90;          // altura de buje (m), coherente con el macromodelo

// ── Geometrías compartidas ───────────────────────────────────────────────────
// Fuste marcadamente cónico: más ancho abajo, más angosto arriba.
const mastGeo    = new THREE.CylinderGeometry(1.05, 2.7, TOWER_H, 32, 1, false);
const nacelleGeo = new THREE.BoxGeometry(3.4, 3.2, 9.0);   // góndola (cuerpo del generador)
const nacelleNose= new THREE.CylinderGeometry(1.7, 1.7, 1.2, 20);  // cuello buje–góndola
const hubGeo     = new THREE.SphereGeometry(1.7, 22, 16);
const noseGeo    = new THREE.ConeGeometry(1.55, 3.0, 24);
const sensorGeo  = new THREE.SphereGeometry(1.05, 18, 14);
const gatewayGeo = new THREE.BoxGeometry(2.2, 1.8, 2.2);

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
  // Torre celeste y clara (metalness 0 → el color difuso se lee tal cual, sin oscurecer)
  tower:   new THREE.MeshStandardMaterial({ color: 0x9cd2f7, metalness: 0, roughness: 0.6 }),
  nacelle: new THREE.MeshStandardMaterial({ color: 0xdaeefc, metalness: 0, roughness: 0.55 }),
  hub:     new THREE.MeshStandardMaterial({ color: 0xbfddf3, metalness: 0, roughness: 0.55 }),
  blade:   new THREE.MeshStandardMaterial({ color: 0xeaf6ff, metalness: 0, roughness: 0.6 }),
};

// Hitbox INVISIBLE (no escribe color ni profundidad, pero sí intercepta el raycast)
// → blanco de selección mucho más grande que el fuste, fácil de pinchar desde lejos.
const hitboxGeo = new THREE.CylinderGeometry(15, 15, TOWER_H + 24, 10);
const hitboxMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

// Material «fantasma» (silueta de lo que falta construir) — se CLONA por torre
// porque cada una lleva su propio plano de corte (avance 4D).
const ghostMatBase = new THREE.MeshBasicMaterial({ color: 0x8fb9d6, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });

let _uid = 0;

/**
 * Crea una torre eólica completa y animable.
 * @param {object} o { id?, yaw?, spin? }
 * @returns objeto con { group, rotor, sensors[], gateway, bodyMats[], spin, id }
 */
export function createTurbine(o = {}) {
  const id = o.id ?? `WT-${String(++_uid).padStart(2, '0')}`;
  const yaw = o.yaw ?? (Math.random() * Math.PI * 2);
  const spin = o.spin ?? (0.30 + Math.random() * 0.12);  // rad/s, giro lento + leve variación

  const group = new THREE.Group();
  group.userData.turbineId = id;

  // Fundación circular típica de aerogenerador
  group.add(circularFoundation(9));

  const bodyMats = [baseMats.tower.clone(), baseMats.nacelle.clone(), baseMats.hub.clone(), baseMats.blade.clone()];
  const [mTower, mNacelle, mHub, mBlade] = bodyMats;

  // Fuste
  const mast = new THREE.Mesh(mastGeo, mTower);
  mast.position.y = TOWER_H / 2; mast.castShadow = true; mast.userData.turbineId = id;
  group.add(mast);

  // Fuste «fantasma»: silueta de lo que falta erigir (avance 4D). Misma geometría,
  // material clonado con su propio plano de corte (lo gestiona FleetView.setProgress).
  const ghostMat = ghostMatBase.clone();
  const ghostMast = new THREE.Mesh(mastGeo, ghostMat);
  ghostMast.position.y = TOWER_H / 2; ghostMast.userData.turbineId = id; ghostMast.visible = false;
  group.add(ghostMast);

  // Conjunto superior (góndola + rotor) — gira en azimut (yaw)
  const top = new THREE.Group();
  top.position.y = TOWER_H; top.rotation.y = yaw;
  group.add(top);

  // Góndola: cuerpo del generador (caja) + cuello cónico hacia el buje → lee como turbina
  const nacelle = new THREE.Mesh(nacelleGeo, mNacelle);
  nacelle.position.set(0, 1.6, -1.2); nacelle.castShadow = true;
  top.add(nacelle);
  const neck = new THREE.Mesh(nacelleNose, mNacelle);
  neck.rotation.x = Math.PI / 2; neck.position.set(0, 1.6, 3.3); neck.castShadow = true;
  top.add(neck);

  // Rotor (buje + nariz + 3 aspas) — gira sobre su eje Z local
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.6, 4.0);
  top.add(rotor);

  const hub = new THREE.Mesh(hubGeo, mHub); hub.castShadow = true; rotor.add(hub);
  const nose = new THREE.Mesh(noseGeo, mHub);
  nose.rotation.x = Math.PI / 2; nose.position.z = 1.7; rotor.add(nose);

  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(bladeGeo, mBlade);
    blade.rotation.z = (i * 2 * Math.PI) / 3;
    blade.castShadow = true; blade.userData.turbineId = id;
    rotor.add(blade);
  }

  // Cabeza «fantasma» (góndola + buje + 3 aspas) en el tope: se muestra mientras la
  // torre NO está operativa, para que se reconozca que es un aerogenerador (sin girar).
  // Usa el mismo material fantasma del fuste (mismo plano de corte: queda por encima).
  const topGhost = new THREE.Group();
  topGhost.position.y = TOWER_H; topGhost.rotation.y = yaw;
  const gNac = new THREE.Mesh(nacelleGeo, ghostMat); gNac.position.set(0, 1.6, -1.2); gNac.userData.turbineId = id; topGhost.add(gNac);
  const gRotor = new THREE.Group(); gRotor.position.set(0, 1.6, 4.0);
  gRotor.add(new THREE.Mesh(hubGeo, ghostMat));
  for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(bladeGeo, ghostMat); b.rotation.z = (i * 2 * Math.PI) / 3; b.userData.turbineId = id; gRotor.add(b); }
  topGhost.add(gRotor); topGhost.visible = false;
  group.add(topGhost);

  // ── Capa de vida: 2 sensores MEMS + gateway (chillones, bien visibles, centrados) ──
  const mkLive = (color) => new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, emissive: color, emissiveIntensity: 1.4, roughness: 0.35,
  });
  const sensors = [];
  for (const [tag, hy] of [['acc-top', 0.93], ['acc-mid', 0.5]]) {
    const m = mkLive(0x2bff77);                        // verde brillante
    const s = new THREE.Mesh(sensorGeo, m);
    const r = THREE.MathUtils.lerp(2.7, 1.05, hy);    // radio del fuste cónico a esa altura
    s.position.set(0, TOWER_H * hy, r + 0.2);          // al frente, centrado en el eje
    s.userData = { turbineId: id, sensor: tag };
    group.add(s); sensors.push({ id: tag, mesh: s, mat: m, tag, phase: Math.random() * 6.28, status: 'ok', _hfrac: hy });
  }
  const gMat = mkLive(0x47b6ff);
  const gw = new THREE.Mesh(gatewayGeo, gMat);
  gw.position.set(4.5, 1.0, 4.5); gw.castShadow = true; gw.userData = { turbineId: id, gateway: true };
  group.add(gw);
  const gateway = { mesh: gw, mat: gMat, phase: Math.random() * 6.28 };

  // Hitbox invisible (radio generoso) para seleccionar la torre fácilmente desde lejos.
  const hit = new THREE.Mesh(hitboxGeo, hitboxMat);
  hit.position.y = (TOWER_H + 24) / 2; hit.userData = { turbineId: id, hitbox: true };
  group.add(hit);

  return { id, type: 'turbine', label: o.label ?? `Torre ${id}`, height: TOWER_H, power: '~3 MW',
           group, top, rotor, sensors, gateway, bodyMats, dimMats: bodyMats, spin, yaw, operational: true,
           // Avance 4D: SOLO el fuste se «llena» (corte por debajo); la cabeza (góndola+rotor)
           // se muestra sólida y girando al estar operativa, o como silueta fantasma si no.
           solidMats: [mTower], _ghostHead: topGhost, ghost: { meshes: [ghostMast], mats: [ghostMat] },
           // Avance 4D POR COMPONENTE (Frente 1): refs a cada parte para mostrarla/llenarla
           // según el % de su partida (índices de stages: 1=fuste, 2=góndola, 3=rotor).
           c4d: { mast, ghostMast, nacelle: [nacelle, neck], nacelleGhost: gNac, rotorSolid: rotor, rotorGhost: gRotor } };
}
