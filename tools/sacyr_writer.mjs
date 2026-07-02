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

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
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
