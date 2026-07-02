// ─────────────────────────────────────────────────────────────────────────────
// sacyr_diff.mjs — Frente 5 · fase 5.2 · criterio de aceptación (round-trip).
//
// Verifica el CONTRATO #1: la información sube a ReWind y vuelve a salir sin
// pérdida.  original → JSON(A) → export → JSON(A') ⇒ A == A' (en INFORMACIÓN).
//
// Compara ignorando la FÓRMULA de cada celda (por diseño el export escribe el
// valor, no la fórmula): la igualdad es de {tipo, valor}, no de cómo se calculó.
// Reporta: cobertura (celdas raw), diffs de celda por hoja, y diffs del modelo
// estructurado (protocolos/ciclos/ensayos/catálogos).
//
//   node tools/sacyr_diff.mjs [entrada.xlsx]
// Sale 0 si round-trip sin pérdida; 1 si hay diffs. Se SALTA (0) sin archivo.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import { readSacyr } from './sacyr_reader.mjs';
import { writeSacyrXlsx } from './sacyr_writer.mjs';

const CANDIDATES = [
  process.argv[2], process.env.SACYR_XLSX,
  'C:/Users/jprey/Downloads/Log protocolos SACYR.xlsx',
  `${process.env.USERPROFILE || process.env.HOME || ''}/Downloads/Log protocolos SACYR.xlsx`,
].filter(Boolean);
const path = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!path) { console.log('⚠  sacyr_diff: archivo real no encontrado — SALTADO.'); process.exit(0); }

// Vista normalizada de _raw: Map "hoja!COLr" → "tipo|valor" (ignora fórmula).
function rawView(data) {
  const map = new Map();
  for (const [name, raw] of Object.entries(data._raw)) {
    for (const row of raw.rows) {
      for (const [col, cell] of Object.entries(row.cells)) {
        map.set(`${name}!${col}${row.r}`, `${cell.t}|${cell.v}`);
      }
    }
    for (const [col, text] of Object.entries(raw.headers || {})) {
      map.set(`${name}!${col}${raw.hdrRow}#h`, String(text));
    }
  }
  return map;
}

// Igualdad estructural del modelo (sin meta ni _raw; JSON estable y ordenado).
function stripVolatile(data) {
  const clone = JSON.parse(JSON.stringify({
    protocolos: data.protocolos, ensayosHormigon: data.ensayosHormigon,
    resumen: data.resumen, catalogos: data.catalogos,
  }));
  return JSON.stringify(clone);
}

console.log('archivo:', path);
const A = await readSacyr(new Uint8Array(fs.readFileSync(path)));
const bytes = writeSacyrXlsx(A);
console.log('export en memoria:', (bytes.length / 1024).toFixed(0), 'KB');
const B = await readSacyr(bytes);

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓', m); else { console.log('  ✗', m); fails++; } };

// ── 1. Cobertura: mismo nº de celdas raw en cada hoja ────────────────────────
console.log('\n1. Cobertura por hoja (celdas con dato):');
for (const name of Object.keys(A._raw)) {
  const a = A._raw[name].cellCount, b = B._raw[name] ? B._raw[name].cellCount : -1;
  ok(a === b, `${name}: ${a} → ${b}`);
}

// ── 2. Round-trip celda a celda (ignorando fórmula) ──────────────────────────
console.log('\n2. Round-trip de celdas (tipo|valor):');
const va = rawView(A), vb = rawView(B);
let cellDiffs = 0; const sample = [];
for (const [k, v] of va) {
  const w = vb.get(k);
  if (w !== v) { cellDiffs++; if (sample.length < 10) sample.push(`${k}: «${v}» → «${w}»`); }
}
let extra = 0;
for (const k of vb.keys()) if (!va.has(k)) { extra++; if (sample.length < 10) sample.push(`${k}: (ausente) → «${vb.get(k)}»`); }
ok(cellDiffs === 0, `celdas cambiadas: ${cellDiffs} (de ${va.size})`);
ok(extra === 0, `celdas extra en el export: ${extra}`);
if (sample.length) console.log('    muestra:\n' + sample.map((s) => '      ' + s).join('\n'));

// ── 3. Round-trip del modelo estructurado ────────────────────────────────────
console.log('\n3. Modelo estructurado (protocolos/ciclos/ensayos/catálogos):');
const sa = stripVolatile(A), sb = stripVolatile(B);
ok(sa === sb, `JSON canónico idéntico (${A.protocolos.length} protocolos, ${A.ensayosHormigon.length} ensayos)`);
if (sa !== sb) {
  // localizar primer punto de divergencia para depurar
  let i = 0; while (i < sa.length && sa[i] === sb[i]) i++;
  console.log('    primera divergencia @', i, '\n      A:', sa.slice(i, i + 120), '\n      B:', sb.slice(i, i + 120));
}

console.log(`\n${fails === 0 ? '✅ ROUND-TRIP SIN PÉRDIDA' : `❌ ${fails} fallo(s)`}`);
process.exit(fails === 0 ? 0 : 1);
