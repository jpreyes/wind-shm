// Construye el .s3d del caso 2-014 (placa anular con gradiente térmico, #57).
// Roark&Young / CSI Example 2-014. Placa anular plana en el plano X-Y, empotrada
// en el perímetro exterior, gradiente de 100°F a través del espesor (cara inferior
// más caliente). Malla nR×nT (radial × tangencial).
import { Model } from '../../../js/model/model.js';
import { Serializer } from '../../../js/model/serializer.js';
import fs from 'fs';

export function build2014(nR = 9, nT = 16) {
  const rIn = 3, rOut = 30, t = 1, E = 29000, nu = 0.3, alpha = 6.5e-6, dTgrad = 100;
  const m = new Model();
  m.mode = '3D'; m.units = 'kip-in';
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'Mat', E, G: E / (2 * (1 + nu)), nu, alpha, rho: 0 });

  // Nodos: anillo i (radio r_i) × ángulo j (0..nT-1, envuelve). Placa en plano X-Y (z=0).
  const idAt = new Map();
  for (let i = 0; i <= nR; i++) {
    const r = rIn + (rOut - rIn) * i / nR;
    for (let j = 0; j < nT; j++) {
      const th = 2 * Math.PI * j / nT;
      const node = m.addNode(r * Math.cos(th), r * Math.sin(th), 0, {});
      idAt.set(`${i},${j}`, node.id);
    }
  }
  // Empotramiento: anillo exterior (i=nR) con los 6 GDL fijos
  for (let j = 0; j < nT; j++) m.updateNode(idAt.get(`${nR},${j}`), { restraints: { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } });

  // Áreas shell (membrana+placa) y carga térmica de gradiente
  const lc = m.addLoadCase('Gradiente', false);
  for (let i = 0; i < nR; i++) for (let j = 0; j < nT; j++) {
    const jn = (j + 1) % nT;
    const a = m.addArea([idAt.get(`${i},${j}`), idAt.get(`${i},${jn}`), idAt.get(`${i + 1},${jn}`), idAt.get(`${i + 1},${j}`)],
      mat.id, { thickness: t, behavior: 'shell', planeStrain: false });
    // cara inferior (−z) más caliente: dTbot=+100, dTtop=0
    m.addLoad(lc.id, { type: 'temp', areaId: a.id, dTtop: 0, dTbot: dTgrad });
  }
  const innerNode = idAt.get('0,0');   // borde interno en θ=0 (radial = X)
  return { m, lc, innerNode };
}

if (process.argv[2] === 'write') {
  const { m, innerNode } = build2014(18, 32);
  fs.writeFileSync('examples/verif_2-014_gradiente_termico.s3d', new Serializer().toJSON(m));
  console.log('escrito 18x32; nodos', m.nodes.size, 'areas', m.areas.size, 'innerNode', innerNode);
}
