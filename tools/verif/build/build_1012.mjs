// Construye el .s3d del caso 1-012 (reticulado arriostrado con límites tracción/
// compresión, #56). CSI Example 1-012. Modelo C por defecto (miembro 4 = puntal,
// no-tension). variant: 'A' (sin límites), 'B' (miembro 5 cable), 'C' (miembro 4 puntal).
import { Model } from '../../../js/model/model.js';
import { Serializer } from '../../../js/model/serializer.js';
import fs from 'fs';

export function build1012(variant = 'C') {
  const E = 30000, A = 8, P = 100, Lc = 120;
  const m = new Model();
  m.mode = '3D'; m.units = 'kip-in';
  m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'Acero', E, G: E / 2.6, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'A8', A, Iy: 1, Iz: 1, J: 1, Avy: 0, Avz: 0, kappay: 1, kappaz: 1 });
  // Nodos (plano X-Z); reticulado → uy fija en todos
  const n1 = m.addNode(0,  0, 0,  { ux: 1, uy: 1, uz: 1 });   // apoyo articulado
  const n2 = m.addNode(0,  0, Lc, { uy: 1 });                 // top-izq (carga)
  const n3 = m.addNode(Lc, 0, 0,  { ux: 1, uy: 1, uz: 1 });   // apoyo articulado
  const n4 = m.addNode(Lc, 0, Lc, { uy: 1 });                 // top-der
  const e1 = m.addElement(n1.id, n2.id, mat.id, sec.id);   // col izq
  const e2 = m.addElement(n3.id, n4.id, mat.id, sec.id);   // col der
  const e3 = m.addElement(n2.id, n4.id, mat.id, sec.id);   // viga
  const e4 = m.addElement(n1.id, n4.id, mat.id, sec.id);   // diag TRACCIÓN (1-4)
  const e5 = m.addElement(n2.id, n3.id, mat.id, sec.id);   // diag COMPRESIÓN (2-3)
  if (variant === 'B') m.updateElement(e5.id, { cable: true });            // sin compresión
  if (variant === 'C') m.updateElement(e4.id, { compressionOnly: true });  // sin tracción
  const lc = m.addLoadCase('H', false);
  m.addLoad(lc.id, { type: 'nodal', nodeId: n2.id, F: [P, 0, 0, 0, 0, 0] });   // 100k +X en top-izq
  return { m, lc, nodes: { n1, n2, n3, n4 } };
}

if (process.argv[2] === 'write') {
  const { m } = build1012('C');
  fs.writeFileSync('examples/verif_1-012c_no_tension.s3d', new Serializer().toJSON(m));
  console.log('escrito Model C; nodos', m.nodes.size, 'elems', m.elements.size);
}
