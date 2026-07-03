// ─────────────────────────────────────────────────────────────────────────────
// sacyr_reader.mjs — Frente 5 · fase 5.1
// Lee «Log protocolos SACYR.xlsx» → modelo canónico JSON (round-trip de INFORMACIÓN).
//
// Dos capas por diseño (ver docs/planes/frente-5-calidad-obra.md):
//   • _raw   : captura VERBATIM de cada celda con dato de las hojas de datos
//              (garantiza cobertura=0 y el round-trip original→JSON→export→JSON').
//   • modelo : interpretación estructurada (protocolos con ciclos, ensayos,
//              catálogos) que alimenta la UI «Calidad» y la integración con Obra.
// El modelo se DERIVA del raw → no pueden divergir.
//
// JS puro, sin dependencias (usa lib/xlsx_lite.mjs). Corre en Node (tests/CLI) y
// en el navegador (fase 5.4). Como CLI:  node tools/sacyr_reader.mjs <archivo.xlsx>
// ─────────────────────────────────────────────────────────────────────────────
import { readXlsx, numToCol, colToNum } from '../lib/xlsx_lite.mjs';

// ── Utilidades de valor ───────────────────────────────────────────────────────
const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : null);
const trim = (v) => (typeof v === 'string' ? v.trim() : v);
// Valor canónico de una celda: blank / string vacío → null (coherente con _raw,
// que no captura celdas vacías; evita divergencias en el round-trip del modelo).
const clean = (v) => { const t = trim(v); return isBlank(t) ? null : t; };

// NETWORKDAYS (lun–vie, sin feriados): días hábiles inclusive entre dos fechas.
// El libro usa NETWORKDAYS(inicio,fin)-1 para «días hábiles» de cada ciclo.
function networkDays(d1, d2) {
  if (!(d1 instanceof Date) || !(d2 instanceof Date)) return null;
  let a = Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate());
  let b = Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate());
  const sign = a <= b ? 1 : -1;
  if (sign < 0) { const t = a; a = b; b = t; }
  let count = 0;
  for (let t = a; t <= b; t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) count++;
  }
  return sign * count;
}
// Días hábiles «estilo SACYR» = NETWORKDAYS(envío, retorno) - 1.
function diasHabilesSacyr(fEnvio, fRetorno) {
  const nd = networkDays(fEnvio, fRetorno);
  return nd == null ? null : nd - 1;
}

// Normalización tolerante de estados (solo interna; el raw preserva el literal).
function normEstado(s) {
  if (isBlank(s)) return null;
  const k = String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (k === 'sin comentarios' || k === 'enviado - ok') return 'aprobado';
  if (k.startsWith('con comentarios') || k === 'enviado - con comentarios') return 'conComentarios';
  if (k === 'nulo') return 'nulo';
  if (k === 'informativo') return 'informativo';
  if (k.startsWith('revis') || k.startsWith('revic')) return 'enRevision';
  if (k === 'rechazado') return 'rechazado';
  return 'otro';
}
// «WTG 01» / «WTG01» → id de estructura ReWind «T01». Devuelve null si no aplica.
function wtgToId(elemento) {
  if (isBlank(elemento)) return null;
  const m = String(elemento).match(/WTG\s*0*(\d+)/i);
  return m ? 'T' + String(+m[1]).padStart(2, '0') : null;
}

// ── Captura raw de una hoja (todas las celdas con dato desde DATA@fila) ───────
function captureRaw(sheet, hdrRow, dataRow) {
  const headers = {};
  for (let c = 1; c <= sheet.maxCol; c++) {
    const v = sheet.valRC(hdrRow, c);
    if (!isBlank(v)) headers[numToCol(c)] = String(v).replace(/\s*\n\s*/g, ' ⏎ ').trim();
  }
  const rows = [];
  let cellCount = 0;
  for (let r = dataRow; r <= sheet.maxRow; r++) {
    const cells = {};
    for (let c = 1; c <= sheet.maxCol; c++) {
      const cell = sheet.cellRC(r, c);
      if (!cell || isBlank(cell.value)) continue;
      const col = numToCol(c);
      // Guardar valor + tipo; fechas como ISO; conservar fórmula si la hubiera.
      const rec = { t: cell.type };
      rec.v = cell.isDate ? iso(cell.value) : cell.value;
      if (cell.formula != null) rec.f = cell.formula;
      cells[col] = rec;
      cellCount++;
    }
    if (Object.keys(cells).length) rows.push({ r, cells });
  }
  return { name: sheet.name, hdrRow, dataRow, headers, rows, cellCount };
}

// ── LOG PTL Parque y SSEE → protocolos[] (HDR@6, DATA@7) ──────────────────────
// Cada ciclo ocupa 10 columnas a partir de la col W(23); hasta 5 ciclos.
const CYC_BASE = colToNum('W');          // 23
const CYC_STRIDE = 10;
const CYC_MAX = 5;
const CYC = { tmlEnvio: 0, fechaEnvio: 1, estado: 2, tmlRetorno: 3, item: 4, hyperlink: 5, fechaRetorno: 6, comentarios: 7, diasCorridos: 8, diasHabiles: 9 };

function parseLog(sheet) {
  const protocolos = [];
  const V = (r, colLetter) => clean(sheet.val(colLetter + r));
  for (let r = 7; r <= sheet.maxRow; r++) {
    const codigoDocumento = V(r, 'E');
    // Fila de datos válida = tiene código de documento (o al menos algún dato clave).
    const elemento = V(r, 'G');
    if (isBlank(codigoDocumento) && isBlank(elemento)) continue;

    const ciclos = [];
    for (let k = 0; k < CYC_MAX; k++) {
      const base = CYC_BASE + k * CYC_STRIDE;
      const at = (off) => { const c = sheet.cellRC(r, base + off); return c ? c.value : null; };
      const estadoRaw = clean(at(CYC.estado));
      if (isBlank(estadoRaw)) continue;            // ciclo inexistente (igual que la fórmula O)
      const fechaEnvio = at(CYC.fechaEnvio);
      const fechaRetorno = at(CYC.fechaRetorno);
      const dhFile = at(CYC.diasHabiles);
      const dhCalc = diasHabilesSacyr(fechaEnvio, fechaRetorno);
      ciclos.push({
        n: k + 1,
        tmlEnvio: clean(at(CYC.tmlEnvio)),
        fechaEnvio: iso(fechaEnvio),
        estado: normEstado(estadoRaw),
        estadoRaw: estadoRaw ?? null,
        tmlRetorno: clean(at(CYC.tmlRetorno)),
        item: clean(at(CYC.item)),
        fechaRetorno: iso(fechaRetorno),
        comentarios: clean(at(CYC.comentarios)),
        diasCorridos: typeof at(CYC.diasCorridos) === 'number' ? at(CYC.diasCorridos) : null,
        diasHabiles: typeof dhFile === 'number' ? dhFile : null,   // valor del archivo
        diasHabilesCalc: dhCalc,                                    // recalculado (validación 5.3)
      });
    }

    const estadoActualRaw = V(r, 'P');
    protocolos.push({
      id: `${sheet.name}#${r}`,
      item: V(r, 'A') ?? null,
      codigoDocumento: codigoDocumento ?? null,
      codigoSharepoint: V(r, 'M') ?? null,       // [F] derivado
      hyperlink: V(r, 'AB') ?? null,             // [F] derivado
      area: V(r, 'F') ?? null,
      elemento: elemento ?? null,
      estructuraId: wtgToId(elemento),           // mapeo a ReWind (Tnn) o null
      descripcion: V(r, 'H') ?? null,
      documento: V(r, 'I') ?? null,
      especialidad: V(r, 'K') ?? null,
      hitoPago: V(r, 'J') ?? null,
      fechaDocumento: iso(sheet.val('L' + r)),   // [F] derivado
      correlativo: V(r, 'N') ?? null,            // [F] derivado
      cicloDocumento: V(r, 'O') ?? null,         // [F] derivado
      estadoActual: normEstado(estadoActualRaw),
      estadoActualRaw: estadoActualRaw ?? null,
      ciclos,
      _origen: { hoja: sheet.name, fila: r },
    });
  }
  return protocolos;
}

// ── Ensayos de hormigón (HDR@4, DATA@5) ───────────────────────────────────────
function parseEnsayosHormigon(sheet) {
  if (!sheet) return [];
  const out = [];
  const V = (r, c) => clean(sheet.val(c + r));
  for (let r = 5; r <= sheet.maxRow; r++) {
    const nEnsayo = V(r, 'D');
    const elemento = V(r, 'I');
    if (isBlank(nEnsayo) && isBlank(elemento) && isBlank(V(r, 'G'))) continue;
    out.push({
      id: `${sheet.name}#${r}`,
      item: V(r, 'A') ?? null,
      nEnsayo: nEnsayo ?? null,
      revision: V(r, 'E') ?? null,
      codigoSharepoint: V(r, 'F') ?? null,       // [F]
      planta: V(r, 'G') ?? null,
      grado: V(r, 'H') ?? null,
      elemento: elemento ?? null,
      estructuraId: wtgToId(elemento),
      trabajo: V(r, 'J') ?? null,
      fechas: {
        d3: iso(sheet.val('L' + r)), d7: iso(sheet.val('M' + r)),
        d14: iso(sheet.val('N' + r)), d28: iso(sheet.val('O' + r)),
        d56: iso(sheet.val('P' + r)),
      },
      fechaEnsayo: iso(sheet.val('Q' + r)),      // [F]
      estadoActual: normEstado(V(r, 'R')),
      estadoActualRaw: V(r, 'R') ?? null,
      _origen: { hoja: sheet.name, fila: r },
    });
  }
  return out;
}

// ── Resumen (log histórico paralelo, HDR@4, DATA@5) — captura ligera ─────────
function parseResumen(sheet) {
  if (!sheet) return [];
  const out = [];
  const V = (r, c) => clean(sheet.val(c + r));
  for (let r = 5; r <= sheet.maxRow; r++) {
    const cod = V(r, 'B');
    const elemento = V(r, 'D');
    if (isBlank(cod) && isBlank(elemento)) continue;
    out.push({
      id: `${sheet.name}#${r}`,
      item: V(r, 'A') ?? null,
      codigoDocumento: cod ?? null,
      area: V(r, 'C') ?? null,
      elemento: elemento ?? null,
      estructuraId: wtgToId(elemento),
      pk: V(r, 'E') ?? null,
      descripcion: V(r, 'F') ?? null,
      especialidad: V(r, 'G') ?? null,
      fechaEjecucion: iso(sheet.val('H' + r)),   // [F]
      estatusActual: normEstado(V(r, 'K')),
      estatusActualRaw: V(r, 'K') ?? null,
      _origen: { hoja: sheet.name, fila: r },
    });
  }
  return out;
}

// ── Catálogos (hoja «Listas», B2:F28) ────────────────────────────────────────
function parseCatalogos(sheet) {
  const cat = { areasTrabajo: [], estados: [], areas: [] };
  if (!sheet) return cat;
  const colVals = (letter) => {
    const arr = [];
    for (let r = 3; r <= sheet.maxRow; r++) {
      const v = trim(sheet.val(letter + r));
      if (!isBlank(v)) arr.push(v);
    }
    return arr;
  };
  cat.areasTrabajo = colVals('B');
  cat.estados = colVals('D');
  cat.areas = colVals('F');
  return cat;
}

// ── Entry point del reader ────────────────────────────────────────────────────
export async function readSacyr(bytes) {
  const wb = await readXlsx(bytes);
  const shLog = wb.sheet('LOG PTL Parque y SSEE');
  if (!shLog) throw new Error('sacyr_reader: falta la hoja «LOG PTL Parque y SSEE»');

  const protocolos = parseLog(shLog);
  const ensayosHormigon = parseEnsayosHormigon(wb.sheet('Ensayos Hormigón'));
  const resumen = parseResumen(wb.sheet('Resumen'));
  const catalogos = parseCatalogos(wb.sheet('Listas'));

  // Captura raw de las hojas de datos (backstop de cobertura + round-trip).
  const _raw = {};
  const rawTargets = [
    ['LOG PTL Parque y SSEE', 6, 7], ['Resumen', 4, 5],
    ['Ensayos Hormigón', 4, 5], ['Ensayos Áridos y Calicatas', 4, 5],
    ['Mortero de Nivelación', 4, 5], ['Inf. Geotécnicos', 4, 5],
    ['Listas', 2, 3],   // catálogo (round-trip del catálogo → catalogos)
  ];
  for (const [name, hdr, data] of rawTargets) {
    const sh = wb.sheet(name);
    if (sh) _raw[name] = captureRaw(sh, hdr, data);
  }

  return {
    meta: { fuente: 'Log protocolos SACYR.xlsx', hojas: wb.sheetNames, generado: new Date().toISOString() },
    protocolos, ensayosHormigon, resumen, catalogos,
    _raw,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')));
if (isMain) {
  const fs = await import('node:fs');
  const path = process.argv[2] || 'C:/Users/jprey/Downloads/Log protocolos SACYR.xlsx';
  const bytes = new Uint8Array(fs.readFileSync(path));
  const data = await readSacyr(bytes);
  const totCiclos = data.protocolos.reduce((s, p) => s + p.ciclos.length, 0);
  console.log('── SACYR reader ──');
  console.log('protocolos        :', data.protocolos.length, `(${totCiclos} ciclos)`);
  console.log('ensayos hormigón  :', data.ensayosHormigon.length);
  console.log('resumen           :', data.resumen.length);
  console.log('catálogos         : areasTrabajo', data.catalogos.areasTrabajo.length,
    '· estados', data.catalogos.estados.length, '· áreas', data.catalogos.areas.length);
  console.log('raw hojas         :', Object.entries(data._raw).map(([k, v]) => `${k}=${v.rows.length}f/${v.cellCount}c`).join(' · '));
  const outPath = process.argv[3];
  if (outPath) { fs.writeFileSync(outPath, JSON.stringify(data, null, 2)); console.log('→ escrito', outPath); }
}
