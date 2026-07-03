// ─────────────────────────────────────────────────────────────────────────────
// test_rewind_template.mjs — plantilla estándar ReWind (Frente 5B).
// Autocontenido (no necesita el archivo SACYR). Valida: plantilla vacía legible,
// round-trip modelo→xlsx→modelo, y el dispatcher readQuality (detecta el formato).
//   node tools/test_rewind_template.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { writeTemplate, blankTemplate, readTemplate, readQuality } from './rewind_template.mjs';

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓', m); else { console.log('  ✗', m); fails++; } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);

// ── 1. Plantilla vacía ────────────────────────────────────────────────────────
console.log('1. Plantilla vacía:');
const blank = blankTemplate();
ok(blank instanceof Uint8Array && blank.length > 0, `generada (${blank.length} bytes)`);
const rb = await readTemplate(blank);
eq(rb.protocolos.length, 0, 'sin protocolos');
ok(rb.catalogos.estados.length >= 5, `catálogo de estados poblado (${rb.catalogos.estados.length})`);
eq(rb.meta.formato, 'rewind', 'meta.formato = rewind');

// ── 2. Round-trip del modelo ──────────────────────────────────────────────────
console.log('2. Round-trip modelo → plantilla → modelo:');
const model = {
  protocolos: [
    { id: 'p1', item: 1, codigoDocumento: 'RW-001', area: 'Fundación', elemento: 'WTG 07', estructuraId: 'T07',
      descripcion: 'Excavación', documento: 'Protocolo excavación', especialidad: 'Civil', hitoPago: '1er',
      fechaDocumento: '2026-06-01', estadoActualRaw: 'Con comentarios', estadoActual: 'conComentarios',
      ciclos: [
        { n: 1, tmlEnvio: '100', fechaEnvio: '2026-06-02', estado: 'conComentarios', estadoRaw: 'Con comentarios', tmlRetorno: '80', fechaRetorno: '2026-06-05', comentarios: 'faltan cotas', diasHabiles: 3, diasHabilesCalc: 3 },
        { n: 2, tmlEnvio: '101', fechaEnvio: '2026-06-08', estado: 'aprobado', estadoRaw: 'Sin Comentarios', tmlRetorno: '82', fechaRetorno: '2026-06-10', comentarios: null, diasHabiles: 2, diasHabilesCalc: 2 },
      ] },
    { id: 'p2', item: 2, codigoDocumento: 'RW-002', area: 'LAT', elemento: 'WTG 12', estructuraId: 'T12',
      descripcion: null, documento: 'Hormigonado', especialidad: 'Civil', hitoPago: '2do',
      fechaDocumento: '2026-06-10', estadoActualRaw: 'Sin Comentarios', estadoActual: 'aprobado', ciclos: [] },
  ],
  ensayosHormigon: [
    { id: 'e1', nEnsayo: 'E-001', grado: 'G-40', elemento: 'WTG 07', estructuraId: 'T07', planta: 'Central', trabajo: 'Fundación',
      fechas: { d3: null, d7: null, d14: null, d28: '2026-06-30', d56: null }, norma: 'NCh1037', estadoActualRaw: 'Sin Comentarios', estadoActual: 'aprobado' },
  ],
  catalogos: { areasTrabajo: ['Fundación', 'LAT'], estados: [], areas: [] },
};
const re = await readTemplate(writeTemplate(model));
eq(re.protocolos.length, 2, 'nº de protocolos');
const p1 = re.protocolos[0];
eq(p1.codigoDocumento, 'RW-001', 'p1 código');
eq(p1.area, 'Fundación', 'p1 área');
eq(p1.estructuraId, 'T07', 'p1 elemento→estructura');
eq(p1.estadoActual, 'conComentarios', 'p1 estado');
eq(p1.ciclos.length, 2, 'p1 nº de ciclos (normalizados desde hoja Ciclos)');
eq(p1.ciclos[0].fechaEnvio, '2026-06-02', 'p1 ciclo1 fecha envío');
eq(p1.ciclos[0].estado, 'conComentarios', 'p1 ciclo1 estado');
eq(p1.ciclos[1].estado, 'aprobado', 'p1 ciclo2 estado');
eq(p1.ciclos[0].diasHabilesCalc, 3, 'p1 ciclo1 días hábiles recalculados');
eq(re.protocolos[1].ciclos.length, 0, 'p2 sin ciclos');
eq(re.protocolos[1].estadoActual, 'aprobado', 'p2 estado');
const e1 = re.ensayosHormigon[0];
eq(re.ensayosHormigon.length, 1, 'nº de ensayos');
eq(e1.grado, 'G-40', 'ensayo grado');
eq(e1.fechas.d28, '2026-06-30', 'ensayo fecha d28');
eq(e1.norma, 'NCh1037', 'ensayo norma');

// ── 3. Dispatcher readQuality ────────────────────────────────────────────────
console.log('3. Autodetección de formato:');
const rq = await readQuality(writeTemplate(model));
eq(rq.meta.formato, 'rewind', 'readQuality detecta plantilla ReWind');
let threw = false; try { await readQuality(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])); } catch { threw = true; }
ok(threw, 'formato desconocido → error claro');

console.log(`\n${fails === 0 ? '✅ TODO OK' : `❌ ${fails} fallo(s)`}`);
process.exit(fails === 0 ? 0 : 1);
