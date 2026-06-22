// Construye el .s3d del caso 1-005a (Model A: asentamiento de apoyo, #54).
import { Model } from '../../../js/model/model.js';
import { Serializer } from '../../../js/model/serializer.js';
import fs from 'fs';

const m = new Model();
m.mode = '2D'; m.units = 'kip-in';
m.materials.clear(); m.sections.clear();
const mat = m.addMaterial({ name: 'Acero', E: 29000, G: 11154, nu: 0.3, rho: 0 });
// Sólo flexión: axial y corte RÍGIDOS (A y Av enormes), I=1728 (como SAP: mod área 1e5, sin corte)
const sec = m.addSection({ name: 'C12x12 (sólo flexión)', A: 1.44e7, Iy: 1728, Iz: 1728, J: 1, Avy: 1.44e7, Avz: 1.44e7, kappay: 1, kappaz: 1 });
const n1 = m.addNode(0,   0, 0,   { ux: 1, uz: 1, ry: 1 });   // empotrado
const n2 = m.addNode(0,   0, 144, {});
const n3 = m.addNode(144, 0, 144, {});
const n4 = m.addNode(144, 0, 0,   {});                          // rodillo: uz prescrito, ux/ry libres
m.addElement(n1.id, n2.id, mat.id, sec.id);   // columna izq
m.addElement(n2.id, n3.id, mat.id, sec.id);   // viga
m.addElement(n3.id, n4.id, mat.id, sec.id);   // columna der
m.updateNode(n4.id, { prescDisp: { uz: -0.5 } });   // asentamiento de 0.5"
m.addLoadCase('Asentamiento', false);

fs.writeFileSync('examples/verif_1-005a_asentamiento.s3d', new Serializer().toJSON(m));
console.log('escrito; nodos', m.nodes.size, 'elems', m.elements.size);
