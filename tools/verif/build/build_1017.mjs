// Construye el .s3d del caso 1-017 (vibración de una cuerda tensa, modal+Kg, #55).
// CSI Example 1-017. Cuerda de 100 in tensada a 0.5 k, discretizada en nElem barras.
// La tensión se aplica con una carga estática (Fx=0.5k en el extremo móvil) que
// genera el estado de referencia para Kg; el modal corre sobre K+Kg.
import { Model } from '../../../js/model/model.js';
import { Serializer } from '../../../js/model/serializer.js';
import fs from 'fs';

export function build1017(nElem = 10) {
  const L = 100, E = 30000, d = 1 / 16, A = 0.00306796, rho = 7.324e-7, T = 0.5;
  const I = Math.PI * Math.pow(d, 4) / 64;   // alambre 1/16" → EI despreciable (cuerda)
  const m = new Model();
  m.mode = '2D'; m.units = 'kip-in';
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'Alambre', E, G: E / 2.6, nu: 0.3, rho });
  const sec = m.addSection({ name: 'wire', A, Iy: I, Iz: I, J: 2 * I, Avy: 0, Avz: 0, kappay: 1, kappaz: 1 });
  const nodes = [];
  for (let i = 0; i <= nElem; i++) {
    const x = L * i / nElem;
    // Sólo los EXTREMOS son apoyos (uz fijo). Interiores: uz libre (vibran lateral).
    const r = {};
    if (i === 0) { r.ux = 1; r.uz = 1; }          // ancla izq (uz + ux)
    if (i === nElem) { r.uz = 1; }                 // apoyo der (uz; ux libre → se tensa)
    nodes.push(m.addNode(x, 0, 0, r));
  }
  for (let i = 0; i < nElem; i++) m.addElement(nodes[i].id, nodes[i + 1].id, mat.id, sec.id);
  const lc = m.addLoadCase('Tension', false);
  m.addLoad(lc.id, { type: 'nodal', nodeId: nodes[nElem].id, F: [T, 0, 0, 0, 0, 0] });   // tracción 0.5k
  return { m, lc };
}

if (process.argv[2] === 'write') {
  const { m } = build1017(10);
  fs.writeFileSync('examples/verif_1-017_cuerda_tensa.s3d', new Serializer().toJSON(m));
  console.log('escrito 10 elem; nodos', m.nodes.size, 'elems', m.elements.size);
}
