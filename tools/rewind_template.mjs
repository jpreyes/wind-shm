// ─────────────────────────────────────────────────────────────────────────────
// rewind_template.mjs — Frente 5B · Plantilla estándar ReWind (calidad de obra).
//
// NUESTRO formato de intercambio: un workbook limpio y ordenado que el contratista
// descarga, llena y sube. Es el modelo de SACYR EVOLUCIONADO — misma base normativa
// (ISO 9001 / 19650 / 21500-21502 · ensayos ASTM/EN/NCh) pero mejor organizado:
//   · una hoja «Protocolos» (1 fila = 1 protocolo),
//   · una hoja «Ciclos» que NORMALIZA las revisiones (1 fila = 1 ciclo, ligada por
//     «Código») en vez de las ~50 columnas repetidas del Excel de SACYR,
//   · «Ensayos Hormigón», «Catálogos» (vocabulario controlado ↔ ISO) e «Instrucciones».
//
// La lectura es POR NOMBRE DE CABECERA (tolerante a sinónimos ES/EN y a reordenar
// columnas). Convive con el import de SACYR: `readQuality()` autodetecta el formato.
//
// JS puro (lib/xlsx_*.mjs + helpers del reader SACYR). Node + navegador.
//   CLI:  node tools/rewind_template.mjs plantilla.xlsx     (genera plantilla vacía)
// ─────────────────────────────────────────────────────────────────────────────
import { writeXlsx } from '../lib/xlsx_write.mjs';
import { readXlsx } from '../lib/xlsx_lite.mjs';
import { normEstado, wtgToId, diasHabilesSacyr, isSacyrWorkbook, mapSacyr } from './sacyr_reader.mjs';

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null));
const S = (v) => (v == null || v === '' ? null : String(v).trim());
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[°#]/g, '').replace(/\s+/g, ' ').trim();

// ── Layout de la plantilla (cabecera en fila 1, datos desde fila 2) ───────────
const H_PROTO = ['Item', 'Código', 'Área', 'Elemento', 'Descripción', 'Documento', 'Especialidad', 'Hito de pago', 'Fecha documento', 'Estado actual'];
const H_CICLO = ['Código protocolo', 'N° ciclo', 'TML envío', 'Fecha envío', 'Estado', 'TML retorno', 'Fecha retorno', 'Comentarios', 'Días hábiles'];
const H_ENSAYO = ['N° ensayo', 'Planta', 'Grado', 'Elemento', 'Trabajo', 'Fecha D3', 'Fecha D7', 'Fecha D14', 'Fecha D28', 'Fecha D56', 'Estado', 'Norma'];

// Sinónimos aceptados al LEER (por si el contratista renombra levemente).
const SYN = {
  proto: {
    item: ['item', 'n', 'nro', 'numero'], code: ['codigo', 'codigo documento', 'code', 'document code'],
    area: ['area', 'area de trabajo', 'zona'], element: ['elemento', 'wtg', 'element', 'wtg / vial / elemento'],
    description: ['descripcion', 'description'], document: ['documento', 'document'],
    discipline: ['especialidad', 'discipline', 'disciplina'], milestone: ['hito de pago', 'hito', 'milestone'],
    docDate: ['fecha documento', 'fecha del documento', 'document date'], status: ['estado actual', 'estado', 'status', 'estatus'],
  },
  ciclo: {
    code: ['codigo protocolo', 'codigo', 'code'], n: ['n ciclo', 'ciclo', 'cycle', 'n'],
    tmlEnvio: ['tml envio', 'tml de envio'], sentDate: ['fecha envio', 'fecha de envio', 'sent date'],
    status: ['estado', 'status'], tmlRetorno: ['tml retorno', 'tml de retorno'],
    returnDate: ['fecha retorno', 'fecha de retorno', 'return date'], comments: ['comentarios', 'comments', 'observaciones'],
    workdays: ['dias habiles', 'workdays'],
  },
  ensayo: {
    n: ['n ensayo', 'ensayo', 'n'], plant: ['planta', 'plant'], grade: ['grado', 'tipo', 'tipo o grado', 'grade'],
    element: ['elemento', 'wtg', 'element'], work: ['trabajo', 'work'],
    d3: ['fecha d3', 'd3', 'dia 3'], d7: ['fecha d7', 'd7', 'dia 7'], d14: ['fecha d14', 'd14', 'dia 14'],
    d28: ['fecha d28', 'd28', 'dia 28'], d56: ['fecha d56', 'd56', 'dia 56'],
    status: ['estado', 'status', 'estatus'], norm: ['norma', 'norm', 'standard'],
  },
};

// Vocabulario controlado ↔ ISO 19650 (para la hoja «Catálogos» y la doc).
const ESTADOS_ISO = [
  ['Sin Comentarios', 'aprobado', 'Autorizado / sin observaciones (ISO 19650: A / status aceptado)'],
  ['Con comentarios', 'conComentarios', 'Aprobado con comentarios / revisar y reenviar (B)'],
  ['En Revisión', 'enRevision', 'En revisión (work in progress / shared)'],
  ['Rechazado', 'rechazado', 'Rechazado'],
  ['Nulo', 'nulo', 'Fuera de flujo'],
  ['Informativo', 'informativo', 'Sólo información'],
];
const DEFAULT_AREAS = ['Fundación', 'Plataforma', 'Vial', 'LAT', 'Subestación', 'Obra de arte'];
const DEFAULT_ESPEC = ['Topografía', 'Civil', 'Eléctrico', 'Calidad', 'Registro', 'Informativo'];

// ── Escritura de la plantilla desde el modelo canónico ───────────────────────
export function writeTemplate(data = {}) {
  const cellStr = (r, c, v) => (S(v) == null ? null : { ref: c + r, t: 'string', v: String(v) });
  const cellNum = (r, c, v) => (typeof v === 'number' && isFinite(v) ? { ref: c + r, t: 'number', v } : null);
  const cellDate = (r, c, v) => (iso(v) ? { ref: c + r, t: 'date', v: iso(v) } : null);
  const COL = (i) => String.fromCharCode(65 + i);
  const headerCells = (headers) => headers.map((h, i) => ({ ref: COL(i) + 1, t: 'string', v: h }));

  // Protocolos
  const proto = { name: 'Protocolos', cells: headerCells(H_PROTO) };
  (data.protocolos || []).forEach((p, i) => {
    const r = i + 2; const push = (c) => c && proto.cells.push(c);
    push(cellNum(r, 'A', typeof p.item === 'number' ? p.item : i + 1) || cellStr(r, 'A', p.item ?? i + 1));
    push(cellStr(r, 'B', p.codigoDocumento)); push(cellStr(r, 'C', p.area)); push(cellStr(r, 'D', p.elemento));
    push(cellStr(r, 'E', p.descripcion)); push(cellStr(r, 'F', p.documento)); push(cellStr(r, 'G', p.especialidad));
    push(cellStr(r, 'H', p.hitoPago)); push(cellDate(r, 'I', p.fechaDocumento)); push(cellStr(r, 'J', p.estadoActualRaw));
  });

  // Ciclos (normalizado: 1 fila por ciclo, ligado por «Código protocolo»)
  const ciclos = { name: 'Ciclos', cells: headerCells(H_CICLO) };
  let cr = 2;
  for (const p of (data.protocolos || [])) {
    for (const c of (p.ciclos || [])) {
      const r = cr++; const push = (x) => x && ciclos.cells.push(x);
      push(cellStr(r, 'A', p.codigoDocumento)); push(cellNum(r, 'B', c.n));
      push(cellStr(r, 'C', c.tmlEnvio)); push(cellDate(r, 'D', c.fechaEnvio)); push(cellStr(r, 'E', c.estadoRaw));
      push(cellStr(r, 'F', c.tmlRetorno)); push(cellDate(r, 'G', c.fechaRetorno)); push(cellStr(r, 'H', c.comentarios));
      push(cellNum(r, 'I', typeof c.diasHabiles === 'number' ? c.diasHabiles : c.diasHabilesCalc));
    }
  }

  // Ensayos de hormigón
  const ensayos = { name: 'Ensayos Hormigón', cells: headerCells(H_ENSAYO) };
  (data.ensayosHormigon || []).forEach((e, i) => {
    const r = i + 2; const push = (x) => x && ensayos.cells.push(x); const f = e.fechas || {};
    push(cellStr(r, 'A', e.nEnsayo)); push(cellStr(r, 'B', e.planta)); push(cellStr(r, 'C', e.grado));
    push(cellStr(r, 'D', e.elemento)); push(cellStr(r, 'E', e.trabajo));
    push(cellDate(r, 'F', f.d3)); push(cellDate(r, 'G', f.d7)); push(cellDate(r, 'H', f.d14));
    push(cellDate(r, 'I', f.d28)); push(cellDate(r, 'J', f.d56));
    push(cellStr(r, 'K', e.estadoActualRaw)); push(cellStr(r, 'L', e.norma));
  });

  // Catálogos (vocabulario controlado ↔ ISO)
  const cat = { name: 'Catálogos', cells: [
    { ref: 'A1', t: 'string', v: 'Áreas' }, { ref: 'C1', t: 'string', v: 'Estados (usar en «Estado»)' },
    { ref: 'D1', t: 'string', v: 'Equivalente ISO 19650' }, { ref: 'F1', t: 'string', v: 'Especialidades' },
  ] };
  const areas = (data.catalogos?.areasTrabajo?.length ? data.catalogos.areasTrabajo : DEFAULT_AREAS);
  areas.forEach((a, i) => cat.cells.push({ ref: 'A' + (i + 2), t: 'string', v: String(a) }));
  ESTADOS_ISO.forEach((row, i) => { cat.cells.push({ ref: 'C' + (i + 2), t: 'string', v: row[0] }, { ref: 'D' + (i + 2), t: 'string', v: row[2] }); });
  DEFAULT_ESPEC.forEach((e, i) => cat.cells.push({ ref: 'F' + (i + 2), t: 'string', v: e }));

  // Instrucciones (base normativa + cómo llenar)
  const guia = [
    'PLANTILLA DE CALIDAD DE OBRA — ReWind',
    '',
    'Formato estándar de intercambio. Base normativa: ISO 9001 (sistema de calidad),',
    'ISO 19650 (ciclos de revisión / transmittals), ISO 21500-21502 (avance),',
    'ensayos ASTM/EN/NCh (equivalentes entre sí).',
    '',
    'CÓMO LLENARLA:',
    '· Hoja «Protocolos»: una fila por protocolo. «Código» es la clave única.',
    '   «Estado actual» debe ser uno de los valores de la hoja «Catálogos».',
    '   «Elemento» con formato «WTG 07» se vincula a la torre 07 del parque (opcional).',
    '· Hoja «Ciclos»: una fila por revisión, ligada al protocolo por «Código protocolo».',
    '   (Reemplaza las columnas repetidas de otros formatos: aquí cada ciclo es una fila.)',
    '   «Días hábiles» se recalcula solo si dejás Fecha envío y Fecha retorno.',
    '· Hoja «Ensayos Hormigón»: probetas por edad (3/7/14/28/56 días). «Norma» = ASTM/EN/NCh.',
    '· No borres las cabeceras (fila 1). Podés reordenar columnas: se leen por nombre.',
    '',
    'Al subirla a ReWind se lee por nombre de cabecera (tolerante a sinónimos ES/EN).',
  ];
  const instr = { name: 'Instrucciones', cells: guia.map((line, i) => ({ ref: 'A' + (i + 1), t: 'string', v: line })) };

  return writeXlsx([instr, proto, ciclos, ensayos, cat]);
}

export function blankTemplate() { return writeTemplate({ protocolos: [], ensayosHormigon: [], catalogos: {} }); }

// ── Lectura de la plantilla (por nombre de cabecera) → modelo canónico ───────
function headerIndex(sheet, row = 1) {
  const map = new Map();
  if (!sheet) return map;
  for (let c = 1; c <= sheet.maxCol; c++) { const v = sheet.valRC(row, c); if (v != null && String(v).trim() !== '') map.set(norm(v), c); }
  return map;
}
function picker(sheet, syn) {
  const idx = headerIndex(sheet);
  const colOf = {};
  for (const key in syn) { for (const name of syn[key]) { if (idx.has(name)) { colOf[key] = idx.get(name); break; } } }
  return (r, key) => { const c = colOf[key]; return c ? sheet.valRC(r, c) : null; };
}

export function isTemplateWorkbook(wb) { return !!wb.sheet('Protocolos'); }

export function mapTemplate(wb) {
  const shP = wb.sheet('Protocolos');
  if (!shP) throw new Error('rewind_template: falta la hoja «Protocolos»');
  const gp = picker(shP, SYN.proto);

  const protocolos = [];
  const byCode = new Map();
  for (let r = 2; r <= shP.maxRow; r++) {
    const code = S(gp(r, 'code')); const element = S(gp(r, 'element'));
    if (!code && !element) continue;
    const estadoRaw = S(gp(r, 'status'));
    const p = {
      id: `Plantilla#${r}`, item: gp(r, 'item') ?? (protocolos.length + 1),
      codigoDocumento: code, codigoSharepoint: null, hyperlink: null,
      area: S(gp(r, 'area')), elemento: element, estructuraId: wtgToId(element),
      descripcion: S(gp(r, 'description')), documento: S(gp(r, 'document')),
      especialidad: S(gp(r, 'discipline')), hitoPago: S(gp(r, 'milestone')),
      fechaDocumento: iso(gp(r, 'docDate')), correlativo: null, cicloDocumento: null,
      estadoActual: normEstado(estadoRaw), estadoActualRaw: estadoRaw,
      ciclos: [], _origen: { hoja: 'Protocolos', fila: r },
    };
    protocolos.push(p);
    if (code) byCode.set(code, p);
  }

  // Ciclos → se adjuntan al protocolo por «Código protocolo».
  const shC = wb.sheet('Ciclos');
  if (shC) {
    const gc = picker(shC, SYN.ciclo);
    const buckets = new Map();
    for (let r = 2; r <= shC.maxRow; r++) {
      const code = S(gc(r, 'code')); if (!code) continue;
      const p = byCode.get(code); if (!p) continue;   // ciclo sin protocolo → ignorar
      const fe = gc(r, 'sentDate'), fr = gc(r, 'returnDate');
      const estadoRaw = S(gc(r, 'status'));
      const dhFile = gc(r, 'workdays');
      const dhCalc = (fe && fr) ? diasHabilesSacyr(new Date(iso(fe) + 'T00:00:00Z'), new Date(iso(fr) + 'T00:00:00Z')) : null;
      (buckets.get(p) || buckets.set(p, []).get(p)).push({
        nRaw: gc(r, 'n'),
        tmlEnvio: S(gc(r, 'tmlEnvio')), fechaEnvio: iso(fe), estado: normEstado(estadoRaw), estadoRaw,
        tmlRetorno: S(gc(r, 'tmlRetorno')), item: null, fechaRetorno: iso(fr), comentarios: S(gc(r, 'comments')),
        diasCorridos: null, diasHabiles: typeof dhFile === 'number' ? dhFile : null, diasHabilesCalc: dhCalc,
      });
    }
    for (const [p, list] of buckets) {
      list.sort((a, b) => (+a.nRaw || 0) - (+b.nRaw || 0));
      p.ciclos = list.map((c, i) => { const { nRaw, ...rest } = c; return { n: i + 1, ...rest }; });
      p.cicloDocumento = ['1er', '2da', '3ero', '4to', '5to'][p.ciclos.length - 1] || null;
      if (!p.estadoActualRaw && p.ciclos.length) { const last = p.ciclos[p.ciclos.length - 1]; p.estadoActualRaw = last.estadoRaw; p.estadoActual = normEstado(last.estadoRaw); }
    }
  }

  // Ensayos de hormigón
  const ensayosHormigon = [];
  const shE = wb.sheet('Ensayos Hormigón');
  if (shE) {
    const ge = picker(shE, SYN.ensayo);
    for (let r = 2; r <= shE.maxRow; r++) {
      const n = S(ge(r, 'n')), element = S(ge(r, 'element')), grade = S(ge(r, 'grade'));
      if (!n && !element && !grade) continue;
      const estadoRaw = S(ge(r, 'status'));
      ensayosHormigon.push({
        id: `PlantillaE#${r}`, nEnsayo: n, planta: S(ge(r, 'plant')), grado: grade,
        elemento: element, estructuraId: wtgToId(element), trabajo: S(ge(r, 'work')),
        fechas: { d3: iso(ge(r, 'd3')), d7: iso(ge(r, 'd7')), d14: iso(ge(r, 'd14')), d28: iso(ge(r, 'd28')), d56: iso(ge(r, 'd56')) },
        norma: S(ge(r, 'norm')), estadoActual: normEstado(estadoRaw), estadoActualRaw: estadoRaw,
        _origen: { hoja: 'Ensayos Hormigón', fila: r },
      });
    }
  }

  // Catálogos
  const catalogos = { areasTrabajo: [], estados: [], areas: [] };
  const shCat = wb.sheet('Catálogos');
  if (shCat) {
    const col = (letter, dst) => { for (let r = 2; r <= shCat.maxRow; r++) { const v = S(shCat.val(letter + r)); if (v) dst.push(v); } };
    col('A', catalogos.areasTrabajo); col('C', catalogos.estados);
  }

  return { meta: { fuente: 'Plantilla ReWind', formato: 'rewind', hojas: wb.sheetNames, generado: new Date().toISOString() }, protocolos, ensayosHormigon, resumen: [], catalogos };
}

export async function readTemplate(bytes) { return mapTemplate(await readXlsx(bytes)); }

// ── Dispatcher: autodetección de formato (SACYR ↔ plantilla ReWind) ──────────
export async function readQuality(bytes) {
  const wb = await readXlsx(bytes);
  if (isSacyrWorkbook(wb)) return mapSacyr(wb);
  if (isTemplateWorkbook(wb)) return mapTemplate(wb);
  throw new Error('Formato no reconocido: se esperaba el Log de SACYR o la plantilla ReWind (hoja «Protocolos»).');
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = typeof process !== 'undefined' && process.argv?.[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const fs = await import('node:fs');
  const out = process.argv[2] || 'plantilla-rewind-calidad.xlsx';
  fs.writeFileSync(out, blankTemplate());
  console.log('→ plantilla vacía escrita:', out);
}
