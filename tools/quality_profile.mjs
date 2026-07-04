// ─────────────────────────────────────────────────────────────────────────────
// quality_profile.mjs — Frente 5B · import CONTRATISTA-AGNÓSTICO
//
// Un motor, muchos perfiles: en vez de un reader cableado por contratista, un
// PERFIL (JSON) describe dónde está cada dato en SU Excel, y `readByProfile` lo
// mapea al MISMO modelo canónico (protocolo → estado) que ya consumen el
// dashboard, los hitos/WBS y el avance 4D. El asistente de mapeo (calidad.js)
// propone el perfil por heurística de sinónimos y lo guarda para reutilizarlo.
//
// El modelo canónico es el estándar (ISO 9001/19650/21500-21502); sólo cambia la
// «piel» del Excel. JS puro, sin dependencias nuevas (usa lib/xlsx_lite.mjs).
// Node (tests) + navegador.
// ─────────────────────────────────────────────────────────────────────────────
import { numToCol } from '../lib/xlsx_lite.mjs';
import { normEstado } from './sacyr_reader.mjs';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (v) => { const t = typeof v === 'string' ? v.trim() : v; return (t == null || t === '') ? null : t; };

// Perfiles built-in: formatos que ReWind ya sabe leer con un reader especializado
// (SACYR conserva su round-trip sin pérdida; la plantilla ReWind es zero-config).
// Aparecen como perfiles seleccionables junto a los del asistente → SACYR pasa a
// ser «un perfil más», no *el* formato. El `builtin` enruta al reader correcto.
export const BUILTIN_PROFILES = [
  { name: 'SACYR Camán', builtin: 'sacyr', desc: 'Log de protocolos SACYR (round-trip sin pérdida).' },
  { name: 'Plantilla ReWind', builtin: 'rewind', desc: 'Plantilla estándar ReWind (ISO 9001/19650).' },
];

// Campos canónicos que el asistente mapea a una columna del Excel del contratista.
// `req` = recomendado para que el import sea útil; `syn` = sinónimos ES/EN.
export const FIELDS = [
  { key: 'codigoDocumento', label: 'Código / N° documento', syn: ['codigo', 'code', 'n documento', 'nro documento', 'id', 'n protocolo', 'protocolo', 'documento n'] },
  { key: 'elemento', label: 'Elemento / estructura', req: true, syn: ['elemento', 'estructura', 'wtg', 'aerogenerador', 'turbina', 'torre', 'tag', 'ubicacion tecnica'] },
  { key: 'area', label: 'Área de trabajo', syn: ['area', 'area de trabajo', 'zona', 'sector', 'frente', 'especialidad obra'] },
  { key: 'hitoPago', label: 'Hito / partida', syn: ['hito', 'hito de pago', 'partida', 'item', 'milestone', 'actividad'] },
  { key: 'especialidad', label: 'Especialidad / disciplina', syn: ['especialidad', 'disciplina', 'discipline', 'tipo'] },
  { key: 'descripcion', label: 'Descripción', syn: ['descripcion', 'description', 'detalle', 'glosa'] },
  { key: 'documento', label: 'Documento / nombre', syn: ['documento', 'nombre', 'archivo', 'plano', 'titulo'] },
  { key: 'estado', label: 'Estado', req: true, syn: ['estado', 'status', 'estatus', 'situacion', 'resultado', 'estado actual', 'estado documento'] },
];

// Fila de cabecera = la de mayor densidad de celdas-texto en las primeras 15 filas.
export function detectHeaderRow(sheet) {
  let best = 1, bestN = 0;
  for (let r = 1; r <= Math.min(15, sheet.maxRow); r++) {
    let n = 0;
    for (let c = 1; c <= sheet.maxCol; c++) { const v = sheet.valRC(r, c); if (typeof v === 'string' && v.trim()) n++; }
    if (n > bestN) { bestN = n; best = r; }
  }
  return best;
}

// Cabeceras (col + etiqueta) de una hoja en su fila de cabecera.
export function headersOf(sheet, hdrRow) {
  const out = [];
  for (let c = 1; c <= sheet.maxCol; c++) {
    const v = sheet.valRC(hdrRow, c);
    if (v != null && String(v).trim()) out.push({ col: numToCol(c), label: String(v).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

// Resumen de todas las hojas del libro (para elegir la de protocolos en el asistente).
export function analyzeWorkbook(wb) {
  return wb.sheetNames.map((name) => {
    const sh = wb.sheet(name); const hdr = detectHeaderRow(sh);
    return { name, headerRow: hdr, dataRow: hdr + 1, rows: Math.max(0, sh.maxRow - hdr), headers: headersOf(sh, hdr) };
  });
}

// Propone { campo → columna } por sinónimos (match exacto pesa más que inclusión).
export function proposeMapping(hdrs) {
  const map = {};
  const used = new Set();
  for (const f of FIELDS) {
    let bestCol = null, bestScore = 0;
    for (const h of hdrs) {
      if (used.has(h.col)) continue;
      const hn = norm(h.label);
      for (const s of f.syn) {
        const score = hn === s ? 3 : (hn.includes(s) || s.includes(hn) ? 2 : 0);
        if (score > bestScore) { bestScore = score; bestCol = h.col; }
      }
    }
    if (bestCol) { map[f.key] = bestCol; used.add(bestCol); }
  }
  return map;
}

// Valores distintos de una columna (para mapear el vocabulario de estado).
export function distinctValues(sheet, dataRow, col, max = 40) {
  const set = new Set();
  for (let r = dataRow; r <= sheet.maxRow && set.size < max; r++) {
    const v = sheet.val(col + r);
    if (v != null && String(v).trim()) set.add(String(v).trim());
  }
  return [...set];
}

// Estados canónicos a los que se mapea (para el desplegable del asistente).
export const CANON_STATES = ['aprobado', 'conComentarios', 'enRevision', 'rechazado', 'nulo', 'informativo'];

// Adivina el estado canónico de un literal desconocido — SIEMPRE dentro de
// CANON_STATES (a diferencia de normEstado, que puede devolver 'otro'). Sirve de
// default en el asistente de mapeo para que el desplegable y el valor coincidan.
export function guessCanon(v) {
  const c = normEstado(v);
  if (CANON_STATES.includes(c)) return c;
  const n = String(v ?? '').toLowerCase();
  if (/observ|comenta|\bobs\b/.test(n)) return 'conComentarios';
  if (/rechaz|reject|no conform|devuel/.test(n)) return 'rechazado';
  if (/anula|nulo|void|cancel/.test(n)) return 'nulo';
  if (/inform/.test(n)) return 'informativo';
  if (/aprob|\bok\b|conforme|libera|cerrad|aceptad/.test(n)) return 'aprobado';
  return 'enRevision';   // por defecto: pendiente
}

// Mapea un WTG/elemento a id de estructura ReWind según patrón+plantilla del perfil.
export function mapElemento(el, profile) {
  if (el == null) return null;
  const pat = profile?.element?.pattern ? new RegExp(profile.element.pattern, 'i') : /WTG\s*0*(\d+)/i;
  const tpl = profile?.element?.template || 'T$1';
  const m = String(el).match(pat);
  return m ? tpl.replace(/\$(\d+)/g, (_, i) => { const g = m[+i]; return g == null ? '' : (/^\d+$/.test(g) ? String(+g).padStart(2, '0') : g); }) : null;
}

// Lee protocolos de un workbook con un PERFIL → modelo canónico.
// profile = { name, sheet, headerRow, dataRow, columns:{campo→col}, statusMap:{literal→canon}, element:{pattern,template} }
export function readByProfile(wb, profile) {
  const sh = wb.sheet(profile.sheet);
  if (!sh) throw new Error(`quality_profile: falta la hoja «${profile.sheet}»`);
  const cols = profile.columns || {};
  const dataRow = profile.dataRow || ((profile.headerRow || 1) + 1);
  const sMap = profile.statusMap || {};
  const V = (r, key) => { const c = cols[key]; return c ? clean(sh.val(c + r)) : null; };
  const protocolos = [];
  for (let r = dataRow; r <= sh.maxRow; r++) {
    const cod = V(r, 'codigoDocumento'), el = V(r, 'elemento'), est = V(r, 'estado'), desc = V(r, 'descripcion');
    if (cod == null && el == null && est == null && desc == null) continue;   // fila vacía
    const estadoRaw = est;
    protocolos.push({
      id: `${profile.sheet}#${r}`, item: r - dataRow + 1,
      codigoDocumento: cod, codigoSharepoint: null, hyperlink: null,
      area: V(r, 'area'), elemento: el, estructuraId: mapElemento(el, profile),
      descripcion: desc, documento: V(r, 'documento'),
      especialidad: V(r, 'especialidad'), hitoPago: V(r, 'hitoPago'),
      fechaDocumento: null, correlativo: null, cicloDocumento: null,
      estadoActual: (estadoRaw != null && sMap[estadoRaw]) || normEstado(estadoRaw),
      estadoActualRaw: estadoRaw, ciclos: [],
      _origen: { hoja: profile.sheet, fila: r },
    });
  }
  return {
    meta: { fuente: profile.name || 'Perfil de contratista', formato: 'profile', perfil: profile.name || null, generado: new Date().toISOString() },
    protocolos, ensayosHormigon: [], resumen: [], catalogos: {},
    _profile: profile,
  };
}

// ── CLI de verificación ────────────────────────────────────────────────────────
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const fs = await import('node:fs');
  const { readXlsx } = await import('../lib/xlsx_lite.mjs');
  const path = process.argv[2]; if (!path) { console.error('uso: node tools/quality_profile.mjs <archivo.xlsx>'); process.exit(1); }
  const wb = await readXlsx(new Uint8Array(fs.readFileSync(path)));
  const sheets = analyzeWorkbook(wb);
  console.log('── Hojas ──');
  for (const s of sheets) console.log(`  ${s.name}: hdr@${s.headerRow}, ${s.rows} filas, ${s.headers.length} cols`);
  const main = sheets.sort((a, b) => b.rows - a.rows)[0];
  console.log('\nHoja principal:', main.name);
  const proposed = proposeMapping(main.headers);
  console.log('Mapeo propuesto:', JSON.stringify(proposed));
}
