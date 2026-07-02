// ─────────────────────────────────────────────────────────────────────────────
// xlsx_write.mjs — escritor .xlsx mínimo, sin dependencias, Node + navegador.
//
// Contraparte de xlsx_lite.mjs. Escribe VALORES (no fórmulas): es lo que necesita
// el round-trip de INFORMACIÓN del Frente 5 — «donde el original tiene una fórmula,
// el export escribe el valor». Genera un OOXML mínimo pero válido (abre en
// Excel/LibreOffice sin advertencias): strings inline, números, booleanos, errores
// y fechas (serial + un único estilo de fecha). El zip se arma en modo STORE
// (sin compresión) con CRC32 propio → cero dependencias.
//
// API:  const bytes = writeXlsx([
//          { name:'Hoja', cells:[ {ref:'A1', t:'string', v:'Item'},
//                                 {ref:'B7', t:'number', v:42},
//                                 {ref:'L7', t:'date',   v:'2022-10-17'} ] },
//       ]);
//   t ∈ 'string' | 'number' | 'bool' | 'date' | 'error'   (v: según tipo; date = ISO 'YYYY-MM-DD')
// Devuelve Uint8Array (.xlsx).
// ─────────────────────────────────────────────────────────────────────────────

// ── XML escaping ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function colToNum(letters) { let n = 0; for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64); return n; }
function numToCol(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; }

// ISO 'YYYY-MM-DD' → serial Excel (epoch 1899-12-30 cubre el bug bisiesto 1900).
function isoToSerial(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30);
  return Math.round(ms / 86400000);
}

// ── Un worksheet → sheetN.xml ─────────────────────────────────────────────────
const DATE_STYLE = 1; // índice de cellXf con formato de fecha (ver styles.xml)
function sheetXml(cells) {
  // Agrupar por fila; ordenar filas y columnas.
  const byRow = new Map();
  let maxR = 0, maxC = 0;
  for (const c of cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(c.ref);
    if (!m) continue;
    const col = colToNum(m[1]), row = +m[2];
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push({ col, ...c });
    if (row > maxR) maxR = row;
    if (col > maxC) maxC = col;
  }
  const rowsSorted = [...byRow.keys()].sort((a, b) => a - b);
  let out = '';
  for (const r of rowsSorted) {
    const cs = byRow.get(r).sort((a, b) => a.col - b.col);
    let rowXml = '';
    for (const c of cs) {
      const ref = c.ref;
      if (c.v == null || c.v === '') continue;
      if (c.t === 'string') {
        rowXml += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
      } else if (c.t === 'bool') {
        rowXml += `<c r="${ref}" t="b"><v>${c.v ? 1 : 0}</v></c>`;
      } else if (c.t === 'error') {
        rowXml += `<c r="${ref}" t="e"><v>${esc(c.v)}</v></c>`;
      } else if (c.t === 'date') {
        const s = isoToSerial(c.v);
        if (s == null) rowXml += `<c r="${ref}" t="inlineStr"><is><t>${esc(c.v)}</t></is></c>`;
        else rowXml += `<c r="${ref}" s="${DATE_STYLE}"><v>${s}</v></c>`;
      } else { // number
        rowXml += `<c r="${ref}"><v>${c.v}</v></c>`;
      }
    }
    if (rowXml) out += `<row r="${r}">${rowXml}</row>`;
  }
  const dim = maxR > 0 ? `A1:${numToCol(maxC)}${maxR}` : 'A1';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dim}"/><sheetData>${out}</sheetData></worksheet>`;
}

// ── Libro completo ────────────────────────────────────────────────────────────
function buildParts(sheets) {
  const parts = new Map();
  parts.set('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `</Types>`);
  parts.set('_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`);
  parts.set('xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` + sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + `</sheets></workbook>`);
  parts.set('xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`);
  parts.set('xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
    `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`);
  sheets.forEach((s, i) => parts.set(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.cells)));
  return parts;
}

// ── ZIP (STORE) con CRC32 ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (arr) => { chunks.push(arr); offset += arr.length; };
  const u16 = (n) => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);
  const u32 = (n) => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);

  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(data);
    const localOffset = offset;
    // Local file header (firma 0x04034b50), método 0 (store).
    push(u32(0x04034b50)); push(u16(20)); push(u16(0)); push(u16(0));
    push(u16(0)); push(u16(0));                 // mod time/date (0)
    push(u32(crc)); push(u32(data.length)); push(u32(data.length));
    push(u16(nameBytes.length)); push(u16(0));
    push(nameBytes); push(data);
    // Central directory entry (se emite al final).
    central.push({ name: nameBytes, crc, size: data.length, localOffset });
  }
  const cdStart = offset;
  for (const e of central) {
    push(u32(0x02014b50)); push(u16(20)); push(u16(20)); push(u16(0)); push(u16(0));
    push(u16(0)); push(u16(0));
    push(u32(e.crc)); push(u32(e.size)); push(u32(e.size));
    push(u16(e.name.length)); push(u16(0)); push(u16(0));
    push(u16(0)); push(u16(0)); push(u32(0));
    push(u32(e.localOffset)); push(e.name);
  }
  const cdSize = offset - cdStart;
  // End of central directory.
  push(u32(0x06054b50)); push(u16(0)); push(u16(0));
  push(u16(central.length)); push(u16(central.length));
  push(u32(cdSize)); push(u32(cdStart)); push(u16(0));

  const total = chunks.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0; for (const a of chunks) { out.set(a, p); p += a.length; }
  return out;
}

export function writeXlsx(sheets) {
  return zipStore(buildParts(sheets));
}

export { isoToSerial };
