// ─────────────────────────────────────────────────────────────────────────────
// sacyr_writer.mjs — Frente 5 · fase 5.2
// Modelo canónico (readSacyr) → xlsx de salida, escribiendo VALORES (no fórmulas).
//
// El export reconstruye las hojas de datos desde la capa `_raw` (captura verbatim
// del reader), preservando cada literal en su misma celda — es la garantía del
// round-trip de INFORMACIÓN: original → JSON → export → JSON' ⇒ JSON == JSON'.
// Donde el original tenía una fórmula, aquí queda su último valor calculado (que
// el reader ya leyó del XML). No se re-emiten hojas derivadas/gráficos (fase 5.3).
//
// JS puro (usa lib/xlsx_write.mjs). Node + navegador.
//   CLI:  node tools/sacyr_writer.mjs <entrada.xlsx> <salida.xlsx>
// ─────────────────────────────────────────────────────────────────────────────
import { writeXlsx } from '../lib/xlsx_write.mjs';

// data._raw → lista de hojas para writeXlsx (cabecera + filas de datos).
export function sacyrToSheets(data) {
  const sheets = [];
  for (const [name, raw] of Object.entries(data._raw || {})) {
    const cells = [];
    // Cabecera en su fila original (⏎ visual → salto de línea real, más legible).
    for (const [col, text] of Object.entries(raw.headers || {})) {
      cells.push({ ref: col + raw.hdrRow, t: 'string', v: String(text).replace(/ ⏎ /g, '\n') });
    }
    // Filas de datos: cada celda con su tipo y valor tal cual se leyó.
    for (const row of raw.rows) {
      for (const [col, cell] of Object.entries(row.cells)) {
        cells.push({ ref: col + row.r, t: cell.t, v: cell.v });
      }
    }
    sheets.push({ name, cells });
  }
  return sheets;
}

export function writeSacyrXlsx(data) {
  return writeXlsx(sacyrToSheets(data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Escritor DESDE EL MODELO estructurado (para datos creados/editados en ReWind,
// que no tienen —o tienen desactualizado— el `_raw`). Reconstruye las hojas LOG,
// Ensayos Hormigón y Listas a partir de protocolos/ensayos/catálogos, escribiendo
// VALORES en las mismas columnas que el reader espera → reimporta idéntico.
// ─────────────────────────────────────────────────────────────────────────────
const CYC_BASE = 23;                          // col W
const CYC_STRIDE = 10;
const ORD_LABEL = { 1: '1er', 2: '2da', 3: '3ero', 4: '4to', 5: '5to' };
const numToColLocal = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; };

// Cabeceras canónicas mínimas del LOG (solo por familiaridad; el reader lee por
// columna fija, no por cabecera).
const LOG_HEADERS = {
  A: 'Item', E: 'Código Documento', F: 'Área de trabajo / Elemento', G: 'WTG / VIAL / ELEMENTO',
  H: 'Descripción', I: 'Documento', J: 'Hito de Pago', K: 'Especialidad', L: 'Fecha Documento',
  M: 'Código Sharepoint', N: 'Correlativo', O: 'Ciclo Documento', P: 'Estado Documento', AB: 'Hipervínculo',
};
const cellStr = (ref, v) => (v == null || v === '' ? null : { ref, t: 'string', v: String(v) });
const cellNum = (ref, v) => (typeof v === 'number' && isFinite(v) ? { ref, t: 'number', v } : null);
const cellDate = (ref, v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? { ref, t: 'date', v } : null);
const cellAny = (ref, v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return cellNum(ref, v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return cellDate(ref, v);
  return cellStr(ref, v);
};

function logSheetFromModel(protocolos) {
  const cells = [];
  for (const [col, text] of Object.entries(LOG_HEADERS)) cells.push({ ref: col + 6, t: 'string', v: text });
  let r = 7;
  for (const p of protocolos) {
    const push = (c) => { if (c) cells.push(c); };
    push(cellAny('A' + r, p.item));
    push(cellStr('E' + r, p.codigoDocumento));
    push(cellStr('F' + r, p.area));
    push(cellStr('G' + r, p.elemento));
    push(cellStr('H' + r, p.descripcion));
    push(cellStr('I' + r, p.documento));
    push(cellStr('J' + r, p.hitoPago));
    push(cellStr('K' + r, p.especialidad));
    push(cellDate('L' + r, p.fechaDocumento));
    push(cellStr('M' + r, p.codigoSharepoint));
    push(cellStr('N' + r, p.correlativo));
    push(cellStr('O' + r, p.cicloDocumento || ORD_LABEL[(p.ciclos || []).length] || null));
    push(cellStr('P' + r, p.estadoActualRaw));
    push(cellStr('AB' + r, p.hyperlink));
    (p.ciclos || []).forEach((c, i) => {
      const base = CYC_BASE + i * CYC_STRIDE;
      const col = (off) => numToColLocal(base + off) + r;
      push(cellAny(col(0), c.tmlEnvio));
      push(cellDate(col(1), c.fechaEnvio));
      push(cellStr(col(2), c.estadoRaw));
      push(cellAny(col(3), c.tmlRetorno));
      push(cellAny(col(4), c.item));
      push(cellDate(col(6), c.fechaRetorno));
      push(cellStr(col(7), c.comentarios));
      push(cellNum(col(8), c.diasCorridos));
      push(cellNum(col(9), typeof c.diasHabiles === 'number' ? c.diasHabiles : c.diasHabilesCalc));
    });
    r++;
  }
  return { name: 'LOG PTL Parque y SSEE', cells };
}

function ensayosSheetFromModel(ensayos) {
  const H = { A: 'Item', D: 'N° Ensayo', E: 'Revisión', F: 'Código SharePoint', G: 'Planta', H: 'Tipo o grado de hormigón', I: 'WTG / VIAL / ELEMENTO', J: 'Trabajo', L: 'Día 3', M: 'Día 7', N: 'Día 14', O: 'Día 28', P: 'Día 56', Q: 'Fecha de realización ensayo', R: 'ESTATUS ACTUAL' };
  const cells = [];
  for (const [col, text] of Object.entries(H)) cells.push({ ref: col + 4, t: 'string', v: text });
  let r = 5;
  for (const e of ensayos) {
    const push = (c) => { if (c) cells.push(c); };
    push(cellAny('A' + r, e.item)); push(cellStr('D' + r, e.nEnsayo)); push(cellStr('E' + r, e.revision));
    push(cellStr('F' + r, e.codigoSharepoint)); push(cellStr('G' + r, e.planta)); push(cellStr('H' + r, e.grado));
    push(cellStr('I' + r, e.elemento)); push(cellStr('J' + r, e.trabajo));
    const f = e.fechas || {};
    push(cellDate('L' + r, f.d3)); push(cellDate('M' + r, f.d7)); push(cellDate('N' + r, f.d14)); push(cellDate('O' + r, f.d28)); push(cellDate('P' + r, f.d56));
    push(cellDate('Q' + r, e.fechaEnsayo)); push(cellStr('R' + r, e.estadoActualRaw));
    r++;
  }
  return { name: 'Ensayos Hormigón', cells };
}

function listasSheetFromModel(catalogos = {}) {
  const cells = [];
  cells.push({ ref: 'B2', t: 'string', v: 'Área de trabajo' }, { ref: 'D2', t: 'string', v: 'Estado' }, { ref: 'F2', t: 'string', v: 'Área' });
  const col = (letter, arr) => (arr || []).forEach((v, i) => { if (v != null && v !== '') cells.push({ ref: letter + (3 + i), t: 'string', v: String(v) }); });
  col('B', catalogos.areasTrabajo); col('D', catalogos.estados); col('F', catalogos.areas);
  return { name: 'Listas', cells };
}

export function modelToSheets(data) {
  const sheets = [logSheetFromModel(data.protocolos || [])];
  if ((data.ensayosHormigon || []).length) sheets.push(ensayosSheetFromModel(data.ensayosHormigon));
  sheets.push(listasSheetFromModel(data.catalogos));
  return sheets;
}

// Elige la vía: `_raw` intacto (import prístino, lossless) → raw; si no, modelo.
export function writeSacyrAuto(data) {
  if (data._raw && !data._dirty && !data._rawOmitido) return writeXlsx(sacyrToSheets(data));
  return writeXlsx(modelToSheets(data));
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = typeof process !== 'undefined' && process.argv?.[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const fs = await import('node:fs');
  const { readSacyr } = await import('./sacyr_reader.mjs');
  const inPath = process.argv[2] || 'C:/Users/jprey/Downloads/Log protocolos SACYR.xlsx';
  const outPath = process.argv[3] || 'C:/Users/jprey/AppData/Local/Temp/claude/C--Respaldos-wind-shm/f1397902-e22c-4db8-8be0-14bd1a7266d7/scratchpad/sacyr_export.xlsx';
  const data = await readSacyr(new Uint8Array(fs.readFileSync(inPath)));
  const bytes = writeSacyrXlsx(data);
  fs.writeFileSync(outPath, bytes);
  console.log(`→ export escrito: ${outPath} (${(bytes.length / 1024).toFixed(0)} KB, ${Object.keys(data._raw).length} hojas)`);
}
