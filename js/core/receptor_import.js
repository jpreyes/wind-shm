// ─────────────────────────────────────────────────────────────────────────────
// receptor_import.js — importa receptores (viviendas) para el estudio de sombra
// desde los formatos del rubro: CSV/TXT, KML, KMZ, GeoJSON y Shapefile (.shp).
//
// Devuelve siempre [{ name, lat, lon }] en grados WGS84. Sin dependencias externas:
// KMZ se descomprime con DecompressionStream (nativo) + lectura mínima del ZIP;
// el .shp se lee como binario (sólo geometrías de punto). KML/GeoJSON via DOMParser
// / JSON. Es un módulo ES puro (browser); el .shp/KMZ requieren APIs de navegador.
// ─────────────────────────────────────────────────────────────────────────────

const valid = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) &&
  Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
const pushPt = (out, lat, lon, name) => { if (valid(lat, lon)) out.push({ name: (name || '').trim(), lat, lon }); };

/** Punto de entrada: detecta el formato por extensión y devuelve [{name,lat,lon}]. */
export async function parseReceptorFile(file) {
  const n = (file.name || '').toLowerCase();
  if (n.endsWith('.csv') || n.endsWith('.txt')) return parseCSV(await file.text());
  if (n.endsWith('.kml')) return parseKML(await file.text());
  if (n.endsWith('.geojson') || n.endsWith('.json')) return parseGeoJSON(await file.text());
  if (n.endsWith('.kmz')) return parseKML(await kmzToKML(await file.arrayBuffer()));
  if (n.endsWith('.shp')) return parseSHP(await file.arrayBuffer());
  throw new Error('Formato no soportado: ' + file.name + ' — usa CSV, KML, KMZ, GeoJSON o SHP (puntos).');
}

// ── CSV / TXT ────────────────────────────────────────────────────────────────
// Detecta separador (, ; o tab) y, si hay encabezado, las columnas lat/lon/nombre.
// Sin encabezado, asume orden lat, lon [, nombre].
export function parseCSV(text) {
  const rows = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!rows.length) return [];
  const delim = (rows[0].match(/;/g) || []).length > (rows[0].match(/,/g) || []).length ? ';'
    : (rows[0].includes('\t') ? '\t' : ',');
  const cells = (l) => l.split(delim).map(s => s.trim().replace(/^"|"$/g, ''));
  const num = (s) => parseFloat(delim === ';' ? String(s).replace(',', '.') : s);   // coma decimal sólo si el separador es ';'
  const first = cells(rows[0]);
  const hasHeader = first.some(c => isNaN(num(c)));
  let iLat = 0, iLon = 1, iName = -1, start = 0;
  if (hasHeader) {
    start = 1;
    const h = first.map(c => c.toLowerCase());
    const find = (re) => h.findIndex(x => re.test(x));
    iLat = find(/^(lat|latitud|y)$/); if (iLat < 0) iLat = find(/lat/);
    iLon = find(/^(lon|lng|longitud|x)$/); if (iLon < 0) iLon = find(/lon|lng/);
    iName = find(/nombre|name|id|label|receptor/);
    if (iLat < 0 || iLon < 0) { iLat = 0; iLon = 1; }
  }
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const c = cells(rows[i]); if (c.length < 2) continue;
    pushPt(out, num(c[iLat]), num(c[iLon]), iName >= 0 ? c[iName] : '');
  }
  return out;
}

// ── KML (texto XML) ────────────────────────────────────────────────────────────
export function parseKML(xml) {
  if (typeof DOMParser === 'undefined') throw new Error('KML requiere navegador (DOMParser).');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('KML/KMZ inválido.');
  const out = [];
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const nm = pm.getElementsByTagName('name')[0]?.textContent || '';
    for (const p of pm.getElementsByTagName('Point')) {
      const c = p.getElementsByTagName('coordinates')[0]?.textContent?.trim();
      if (!c) continue;
      const [lon, lat] = c.split(/[\s,]+/).map(Number);   // KML = lon,lat[,alt]
      pushPt(out, lat, lon, nm);
    }
  }
  if (!out.length) for (const co of doc.getElementsByTagName('coordinates')) {
    const [lon, lat] = co.textContent.trim().split(/[\s,]+/).map(Number);
    pushPt(out, lat, lon, '');
  }
  return out;
}

// ── GeoJSON ──────────────────────────────────────────────────────────────────
export function parseGeoJSON(text) {
  const gj = JSON.parse(text);
  const out = [];
  const feats = gj.type === 'FeatureCollection' ? gj.features : (gj.type === 'Feature' ? [gj] : []);
  const nameOf = (props) => props ? (props.name || props.nombre || props.id || props.label || '') : '';
  const eat = (geom, props) => {
    if (!geom) return;
    if (geom.type === 'Point') pushPt(out, geom.coordinates[1], geom.coordinates[0], nameOf(props));
    else if (geom.type === 'MultiPoint') for (const c of geom.coordinates) pushPt(out, c[1], c[0], nameOf(props));
    else if (geom.type === 'GeometryCollection') for (const g of geom.geometries) eat(g, props);
  };
  for (const f of feats) eat(f.geometry, f.properties);
  if (!feats.length && gj.type === 'Point') pushPt(out, gj.coordinates[1], gj.coordinates[0], '');
  return out;
}

// ── KMZ → KML (descompresión nativa + lectura mínima del ZIP) ─────────────────
async function kmzToKML(buf) {
  const dv = new DataView(buf), td = new TextDecoder();
  // Localiza el End Of Central Directory (firma 0x06054b50) cerca del final.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0 && i > buf.byteLength - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('KMZ inválido (sin directorio ZIP).');
  const cdOffset = dv.getUint32(eocd + 16, true), cdCount = dv.getUint16(eocd + 10, true);
  let p = cdOffset, target = null;
  for (let i = 0; i < cdCount; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const fname = td.decode(new Uint8Array(buf, p + 46, nameLen));
    if (/\.kml$/i.test(fname) && (!target || /doc\.kml$/i.test(fname))) target = { method, compSize, localOff };
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!target) throw new Error('KMZ sin archivo .kml dentro.');
  const lh = target.localOff;
  if (dv.getUint32(lh, true) !== 0x04034b50) throw new Error('KMZ: cabecera local inválida.');
  const dataStart = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
  const comp = new Uint8Array(buf.slice(dataStart, dataStart + target.compSize));
  if (target.method === 0) return td.decode(comp);                 // almacenado (sin comprimir)
  if (target.method !== 8) throw new Error('KMZ: método de compresión no soportado.');
  if (typeof DecompressionStream === 'undefined') throw new Error('KMZ requiere DecompressionStream (navegador moderno).');
  const stream = new Response(comp).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return td.decode(await new Response(stream).arrayBuffer());
}

// ── Shapefile (.shp) — sólo geometrías de punto, asume WGS84 lat/lon ──────────
export function parseSHP(buf) {
  const dv = new DataView(buf);
  if (dv.getInt32(0, false) !== 9994) throw new Error('SHP inválido (firma incorrecta).');
  const shapeType = dv.getInt32(32, true);
  if (![1, 11, 21].includes(shapeType)) throw new Error('SHP: sólo se admiten puntos (Point/PointZ/PointM). Tipo=' + shapeType);
  const len = buf.byteLength, raw = [];
  let p = 100, guard = 0;
  while (p + 12 <= len && guard++ < 500000) {
    const contentLen = dv.getInt32(p + 4, false) * 2;   // palabras de 16 bits → bytes
    const rec = p + 8, st = dv.getInt32(rec, true);
    if (st !== 0) raw.push({ x: dv.getFloat64(rec + 4, true), y: dv.getFloat64(rec + 12, true) });   // X=lon, Y=lat
    p = rec + contentLen;
    if (contentLen <= 0) break;
  }
  if (raw.some(r => Math.abs(r.x) > 180 || Math.abs(r.y) > 90))
    throw new Error('SHP: coordenadas fuera del rango lat/lon (¿proyección UTM?). Reproyecta a WGS84 (EPSG:4326).');
  const out = [];
  for (const r of raw) pushPt(out, r.y, r.x, '');
  return out;
}
