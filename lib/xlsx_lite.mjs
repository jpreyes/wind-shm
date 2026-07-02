// ─────────────────────────────────────────────────────────────────────────────
// xlsx_lite.mjs — lector .xlsx mínimo, sin dependencias, Node + navegador.
//
// Solo LEE valores (los que interesan al round-trip de INFORMACIÓN del Frente 5):
// descomprime el zip con la API web `DecompressionStream('deflate-raw')` (global
// en Node ≥18 y en todo navegador evergreen), parsea sharedStrings, detecta qué
// celdas son fecha vía styles.xml, y expande cada hoja a un mapa A1→celda tipada.
// NO evalúa fórmulas: usa el último valor cacheado que el propio xlsx guarda en el
// XML (<c><f>…</f><v>VALOR</v></c>) — exactamente lo que necesita el reader SACYR.
//
// API:  const wb = await readXlsx(bytesUint8Array);
//       wb.sheetNames                     → ['LOG PTL Parque y SSEE', …] (orden del libro)
//       const sh = wb.sheet('Hoja');      → Sheet | null
//       sh.maxRow, sh.maxCol
//       sh.cell('B7')  |  sh.cellRC(row1based, col1based)  → Cell | null
//       Cell = { ref, r, c, type, value, raw, isDate, formula }
//         type ∈ 'string' | 'number' | 'bool' | 'date' | 'error'
//         value: string | number | boolean | Date | null   (fechas → Date UTC)
//         raw:   texto tal cual salió del XML (para preservar literales al exportar)
// ─────────────────────────────────────────────────────────────────────────────

// ── ZIP: leer el central directory y descomprimir cada entrada necesaria ──────
function u32(dv, p) { return dv.getUint32(p, true); }
function u16(dv, p) { return dv.getUint16(p, true); }

async function inflateRaw(bytes) {
  if (bytes.length === 0) return new Uint8Array(0);
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}

// Devuelve Map<nombre, Uint8Array descomprimido> con las entradas que pase el filtro.
async function unzip(u8, wantFn) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // Localizar End Of Central Directory (firma 0x06054b50), buscando desde el final.
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 0x10000; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx_lite: no es un zip válido (falta EOCD)');
  const total = u16(dv, eocd + 10);
  let p = u32(dv, eocd + 16);
  const out = new Map();
  const jobs = [];
  for (let k = 0; k < total; k++) {
    if (u32(dv, p) !== 0x02014b50) break;
    const method = u16(dv, p + 10);
    const compSize = u32(dv, p + 20);
    const nlen = u16(dv, p + 28), elen = u16(dv, p + 30), clen = u16(dv, p + 32);
    const lho = u32(dv, p + 42);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (wantFn && !wantFn(name)) continue;
    // Local header: recalcular offset de datos (name+extra locales pueden diferir).
    const lNlen = u16(dv, lho + 26), lElen = u16(dv, lho + 28);
    const dataStart = lho + 30 + lNlen + lElen;
    const comp = u8.subarray(dataStart, dataStart + compSize);
    jobs.push((async () => {
      out.set(name, method === 0 ? comp.slice() : await inflateRaw(comp));
    })());
  }
  await Promise.all(jobs);
  return out;
}

// ── XML helpers ligeros (los XML de SpreadsheetML son planos y predecibles) ───
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENT[e] ?? m;
  });
}
const td = new TextDecoder('utf-8');

// ── sharedStrings.xml → array de strings ──────────────────────────────────────
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  // Cada <si>…</si> es una cadena; puede tener <t>…</t> o varios <r><t>…</t></r>.
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const body = m[1];
    let s = '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g;
    let tm;
    while ((tm = tRe.exec(body))) s += tm[1] != null ? decodeXml(tm[1]) : '';
    out.push(s);
  }
  return out;
}

// ── styles.xml → set de índices de cellXf que representan FECHAS ──────────────
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function fmtIsDate(code) {
  if (!code) return false;
  // Heurística estándar: quitar literales entre comillas, corchetes de color/cond,
  // y escapes; si quedan tokens de fecha (y/m/d) o de hora, es fecha.
  let s = code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(s) && !/[#0]/.test(s.replace(/[ymdhs:.\-/ ,APM]/gi, ''));
}
function parseDateStyles(xml) {
  const dateXf = new Set();
  if (!xml) return dateXf;
  // numFmts personalizados (id ≥ 164).
  const customDate = new Set();
  const nf = /<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g;
  let m;
  while ((m = nf.exec(xml))) { if (fmtIsDate(decodeXml(m[2]))) customDate.add(+m[1]); }
  // cellXfs: el i-ésimo <xf> es el estilo referenciado por c[s="i"].
  const cellXfsBlock = xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!cellXfsBlock) return dateXf;
  const xfRe = /<xf\b[^>]*\/?>/g;
  let i = 0, xf;
  while ((xf = xfRe.exec(cellXfsBlock[1]))) {
    const idM = xf[0].match(/numFmtId="(\d+)"/);
    const id = idM ? +idM[1] : 0;
    if (BUILTIN_DATE_FMT.has(id) || customDate.has(id)) dateXf.add(i);
    i++;
  }
  return dateXf;
}

// ── Referencias A1 ↔ (fila, col) ──────────────────────────────────────────────
function colToNum(letters) { // 'A'→1, 'AB'→28
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}
function numToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; }
  return s;
}
function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return m ? { c: colToNum(m[1]), r: +m[2] } : null;
}

// Excel serial → Date UTC (epoch 1899-12-30 cubre el bug del año bisiesto 1900).
function serialToDate(n) {
  const ms = Math.round(n * 86400000);
  return new Date(Date.UTC(1899, 11, 30) + ms);
}

// ── Parseo de una hoja: sheetData → Map A1→Cell ──────────────────────────────
function parseSheet(xml, shared, dateXf) {
  const cells = new Map();
  let maxRow = 0, maxCol = 0;
  const body = xml.match(/<sheetData[^>]*>([\s\S]*?)<\/sheetData>/);
  if (!body) return { cells, maxRow, maxCol };
  const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = cRe.exec(body[1]))) {
    const attrs = m[1], inner = m[2] || '';
    const refM = attrs.match(/\br="([A-Z]+\d+)"/);
    if (!refM) continue;
    const ref = refM[1];
    const pos = parseRef(ref);
    const tM = attrs.match(/\bt="([^"]*)"/);
    const t = tM ? tM[1] : 'n';
    const sM = attrs.match(/\bs="(\d+)"/);
    const styleIdx = sM ? +sM[1] : -1;
    const fM = inner.match(/<f[^>]*>([\s\S]*?)<\/f>|<f[^>]*\/>/);
    const formula = fM ? (fM[1] != null ? decodeXml(fM[1]) : '') : null;

    let type, value, raw = null;
    if (t === 's') {                       // shared string
      const vM = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      const idx = vM ? +vM[1] : -1;
      value = shared[idx] ?? '';
      raw = value; type = 'string';
    } else if (t === 'inlineStr') {         // string inline
      let s = ''; const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let tm;
      while ((tm = tRe.exec(inner))) s += decodeXml(tm[1]);
      value = s; raw = s; type = 'string';
    } else if (t === 'str') {               // resultado string de fórmula
      const vM = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      value = vM ? decodeXml(vM[1]) : ''; raw = value; type = 'string';
    } else if (t === 'b') {                 // booleano
      const vM = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      value = vM ? vM[1] === '1' : false; raw = vM ? vM[1] : ''; type = 'bool';
    } else if (t === 'e') {                 // error (#REF!, #DIV/0!…)
      const vM = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      value = vM ? decodeXml(vM[1]) : ''; raw = value; type = 'error';
    } else {                                // número (o fecha por estilo)
      const vM = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      if (!vM) continue;                    // celda vacía con solo estilo → ignorar
      raw = vM[1];
      const num = parseFloat(vM[1]);
      if (styleIdx >= 0 && dateXf.has(styleIdx) && isFinite(num)) {
        value = serialToDate(num); type = 'date';
      } else { value = num; type = 'number'; }
    }
    cells.set(ref, { ref, r: pos.r, c: pos.c, type, value, raw, isDate: type === 'date', formula });
    if (pos.r > maxRow) maxRow = pos.r;
    if (pos.c > maxCol) maxCol = pos.c;
  }
  return { cells, maxRow, maxCol };
}

class Sheet {
  constructor(name, parsed) { this.name = name; this._cells = parsed.cells; this.maxRow = parsed.maxRow; this.maxCol = parsed.maxCol; }
  cell(ref) { return this._cells.get(ref) || null; }
  cellRC(r, c) { return this._cells.get(numToCol(c) + r) || null; }
  // Valor tipado directo (o null si vacía).
  val(ref) { const c = this._cells.get(ref); return c ? c.value : null; }
  valRC(r, c) { const cell = this._cells.get(numToCol(c) + r); return cell ? cell.value : null; }
}

export async function readXlsx(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const files = await unzip(u8, (n) =>
    n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' ||
    n === 'xl/sharedStrings.xml' || n === 'xl/styles.xml' ||
    n.startsWith('xl/worksheets/sheet'));
  const dec = (n) => { const b = files.get(n); return b ? td.decode(b) : ''; };

  const shared = parseSharedStrings(dec('xl/sharedStrings.xml'));
  const dateXf = parseDateStyles(dec('xl/styles.xml'));

  // Mapear nombre de hoja → archivo sheetN.xml vía workbook.xml + rels.
  const relXml = dec('xl/_rels/workbook.xml.rels');
  const relMap = new Map(); // rId → target
  { const re = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g; let m;
    while ((m = re.exec(relXml))) relMap.set(m[1], m[2]); }
  // (algunos escriben Target antes de Id)
  { const re = /<Relationship\b[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g; let m;
    while ((m = re.exec(relXml))) if (!relMap.has(m[2])) relMap.set(m[2], m[1]); }

  const wbXml = dec('xl/workbook.xml');
  const sheetNames = [];
  const sheets = new Map();
  const shRe = /<sheet\b([^>]*)\/?>/g; let sm;
  while ((sm = shRe.exec(wbXml))) {
    const nameM = sm[1].match(/name="([^"]*)"/);
    const ridM = sm[1].match(/r:id="([^"]*)"/);
    if (!nameM || !ridM) continue;
    const name = decodeXml(nameM[1]);
    let target = relMap.get(ridM[1]) || '';
    target = target.replace(/^\/?xl\//, '').replace(/^\.\//, '');
    const full = 'xl/' + target;
    const shXml = files.has(full) ? td.decode(files.get(full)) : '';
    sheetNames.push(name);
    sheets.set(name, new Sheet(name, parseSheet(shXml, shared, dateXf)));
  }

  return {
    sheetNames,
    sheet(name) { return sheets.get(name) || null; },
    _shared: shared,
  };
}

export { colToNum, numToCol, parseRef, serialToDate };
