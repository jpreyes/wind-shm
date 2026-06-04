// ──────────────────────────────────────────────────────────────────────────────
// Serializer — JSON (.s3d) and CSV import/export
// ──────────────────────────────────────────────────────────────────────────────
import { Model } from './model.js';

export class Serializer {

  // ══ JSON (.s3d) ════════════════════════════════════════════════════════════

  toJSON(model) {
    const obj = {
      version: '1.0',
      units: model.units,
      nodes:      [...model.nodes.values()],
      elements:   [...model.elements.values()],
      materials:  [...model.materials.values()],
      sections:   [...model.sections.values()],
      diaphragms:   [...model.diaphragms.values()],
      loadCases:    [...model.loadCases.values()],
      combinations: [...model.combinations.values()],
      _counters:   { ...model._cnt }
    };
    return JSON.stringify(obj, null, 2);
  }

  fromJSON(jsonStr) {
    let obj;
    try { obj = JSON.parse(jsonStr); }
    catch { throw new Error('JSON inválido'); }

    const m = new Model();
    // Clear defaults, we'll load from file
    m.materials.clear(); m.sections.clear();
    m._cnt = { nodes:0, elements:0, materials:0, sections:0, diaphragms:0, loadCases:0, combinations:0 };

    m.units = obj.units || 'kN-m';

    for (const d of (obj.materials || []))  { m.materials.set(d.id, d); }
    for (const d of (obj.sections  || []))  { m.sections.set(d.id, d); }
    for (const d of (obj.nodes     || []))  { m.nodes.set(d.id, d); }
    for (const d of (obj.elements  || []))  { m.elements.set(d.id, d); }
    for (const d of (obj.diaphragms|| []))  { m.diaphragms.set(d.id, d); }
    for (const d of (obj.loadCases    || [])) { m.loadCases.set(d.id, d); }
    for (const d of (obj.combinations || [])) { m.combinations.set(d.id, d); }

    if (obj._counters) {
      m._cnt = { ...m._cnt, ...obj._counters };
    } else {
      // Recompute counters from max IDs
      const maxId = (map) => Math.max(0, ...[...map.keys()]);
      m._cnt.nodes      = maxId(m.nodes);
      m._cnt.elements   = maxId(m.elements);
      m._cnt.materials  = maxId(m.materials);
      m._cnt.sections   = maxId(m.sections);
      m._cnt.diaphragms = maxId(m.diaphragms);
      m._cnt.loadCases  = maxId(m.loadCases);
    }

    // If empty after loading, add defaults
    if (m.materials.size === 0) m._initDefaults();

    return m;
  }

  // ══ CSV ═══════════════════════════════════════════════════════════════════

  toCSV(model) {
    const lines = [];
    const fmt = (v) => {
      if (typeof v === 'number') {
        // Use exponential for very small/large numbers
        if (Math.abs(v) > 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e7)) {
          return v.toExponential(4);
        }
        return +v.toPrecision(8) + '';
      }
      return String(v);
    };

    lines.push('# StructWeb3D CSV Export');
    lines.push(`# Unidades: ${model.units}`);
    lines.push('#');

    lines.push('# TYPE, ID, name, E, G, nu, rho');
    for (const m of model.materials.values()) {
      lines.push(`MATERIAL, ${m.id}, ${m.name}, ${fmt(m.E)}, ${fmt(m.G)}, ${fmt(m.nu)}, ${fmt(m.rho)}`);
    }
    lines.push('#');

    lines.push('# TYPE, ID, name, A, Iz, Iy, J, Avy, Avz, kappay, kappaz');
    for (const s of model.sections.values()) {
      lines.push(`SECTION, ${s.id}, ${s.name}, ${fmt(s.A)}, ${fmt(s.Iz)}, ${fmt(s.Iy)}, ${fmt(s.J)}, ${fmt(s.Avy)}, ${fmt(s.Avz)}, ${fmt(s.kappay)}, ${fmt(s.kappaz)}`);
    }
    lines.push('#');

    lines.push('# TYPE, ID, X, Y, Z, ux, uy, uz, rx, ry, rz  (1=fijo 0=libre)');
    for (const n of model.nodes.values()) {
      const r = n.restraints;
      lines.push(`NODE, ${n.id}, ${fmt(n.x)}, ${fmt(n.y)}, ${fmt(n.z)}, ${r.ux|0}, ${r.uy|0}, ${r.uz|0}, ${r.rx|0}, ${r.ry|0}, ${r.rz|0}`);
    }
    lines.push('#');

    lines.push('# TYPE, ID, n1, n2, mat_id, sec_id');
    for (const e of model.elements.values()) {
      lines.push(`ELEMENT, ${e.id}, ${e.n1}, ${e.n2}, ${e.matId}, ${e.secId}`);
    }
    lines.push('#');

    if (model.diaphragms.size > 0) {
      lines.push('# TYPE, ID, z, nodes(;sep), cm_x, cm_y, mass_m, mass_Icm, ex, ey');
      for (const d of model.diaphragms.values()) {
        const nodes = d.nodes.join(';');
        lines.push(`DIAPHRAGM, ${d.id}, ${fmt(d.z)}, ${nodes}, ${fmt(d.cm.x)}, ${fmt(d.cm.y)}, ${fmt(d.mass.m)}, ${fmt(d.mass.Icm)}, ${fmt(d.eccentricity.ex)}, ${fmt(d.eccentricity.ey)}`);
      }
    }

    return lines.join('\r\n');
  }

  // fromCSV merges into an existing model (or creates a new one if model=null)
  fromCSV(csvStr, baseModel = null) {
    const model  = baseModel ?? new Model();
    const errors = [];

    const rows = csvStr
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    // Parse all rows, group by type
    const parsed = { MATERIAL:[], SECTION:[], NODE:[], ELEMENT:[], DIAPHRAGM:[], LOAD_NODAL:[], LOAD_DIST:[] };

    rows.forEach((line, lineIdx) => {
      const cols = line.split(',').map(c => c.trim());
      const type = (cols[0] || '').toUpperCase();
      if (!parsed[type]) {
        errors.push(`Línea ${lineIdx+1}: tipo desconocido "${cols[0]}"`);
        return;
      }
      parsed[type].push({ cols, line: lineIdx + 1 });
    });

    // ── Materials ────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.MATERIAL) {
      // MATERIAL, id, name, E, G, nu, rho
      if (cols.length < 7) { errors.push(`Línea ${line}: MATERIAL necesita 7 columnas`); continue; }
      const [, id, name, E, G, nu, rho] = cols;
      const obj = { id: +id, name, E: +E, G: +G, nu: +nu, rho: +rho };
      if (isNaN(obj.id) || isNaN(obj.E)) { errors.push(`Línea ${line}: valores numéricos inválidos en MATERIAL`); continue; }
      model.materials.set(obj.id, obj);
      if (obj.id > model._cnt.materials) model._cnt.materials = obj.id;
    }

    // ── Sections ─────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.SECTION) {
      // SECTION, id, name, A, Iz, Iy, J, Avy, Avz, kappay, kappaz
      if (cols.length < 11) { errors.push(`Línea ${line}: SECTION necesita 11 columnas`); continue; }
      const [, id, name, A, Iz, Iy, J, Avy, Avz, kappay, kappaz] = cols;
      const obj = { id: +id, name, A: +A, Iz: +Iz, Iy: +Iy, J: +J,
                    Avy: +Avy, Avz: +Avz, kappay: +kappay, kappaz: +kappaz };
      if (isNaN(obj.id)) { errors.push(`Línea ${line}: ID inválido en SECTION`); continue; }
      model.sections.set(obj.id, obj);
      if (obj.id > model._cnt.sections) model._cnt.sections = obj.id;
    }

    // ── Nodes ─────────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.NODE) {
      // NODE, id, x, y, z, ux, uy, uz, rx, ry, rz
      if (cols.length < 5) { errors.push(`Línea ${line}: NODE necesita al menos 5 columnas`); continue; }
      const [, id, x, y, z, ux=0, uy=0, uz=0, rx=0, ry=0, rz=0] = cols;
      const obj = {
        id: +id, x: +x, y: +y, z: +z,
        restraints: { ux: +ux, uy: +uy, uz: +uz, rx: +rx, ry: +ry, rz: +rz }
      };
      if (isNaN(obj.id) || isNaN(obj.x) || isNaN(obj.y) || isNaN(obj.z)) {
        errors.push(`Línea ${line}: coordenadas inválidas en NODE`); continue;
      }
      model.nodes.set(obj.id, obj);
      if (obj.id > model._cnt.nodes) model._cnt.nodes = obj.id;
    }

    // ── Elements ──────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.ELEMENT) {
      // ELEMENT, id, n1, n2, mat_id, sec_id
      if (cols.length < 6) { errors.push(`Línea ${line}: ELEMENT necesita 6 columnas`); continue; }
      const [, id, n1, n2, matId, secId] = cols;
      const obj = { id: +id, n1: +n1, n2: +n2, matId: +matId, secId: +secId, releases: Array(12).fill(0) };
      if (!model.nodes.has(obj.n1)) { errors.push(`Línea ${line}: nodo n1=${obj.n1} no existe`); continue; }
      if (!model.nodes.has(obj.n2)) { errors.push(`Línea ${line}: nodo n2=${obj.n2} no existe`); continue; }
      model.elements.set(obj.id, obj);
      if (obj.id > model._cnt.elements) model._cnt.elements = obj.id;
    }

    // ── Diaphragms ────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.DIAPHRAGM) {
      if (cols.length < 10) { errors.push(`Línea ${line}: DIAPHRAGM necesita 10 columnas`); continue; }
      const [, id, z, nodesList, cmx, cmy, massM, massIcm, ex, ey] = cols;
      const nodes = nodesList.split(';').map(n => +n.trim()).filter(n => !isNaN(n));
      const obj = {
        id: +id, z: +z, nodes,
        cm: { x: +cmx, y: +cmy },
        mass: { m: +massM, Icm: +massIcm },
        eccentricity: { ex: +ex, ey: +ey }
      };
      model.diaphragms.set(obj.id, obj);
      if (obj.id > model._cnt.diaphragms) model._cnt.diaphragms = obj.id;
    }

    return { model, errors };
  }

  // ══ CSV Template ══════════════════════════════════════════════════════════

  getTemplate() {
    return `# ══════════════════════════════════════════════════════════════
# StructWeb3D — Plantilla CSV v1.0
# Instrucciones:
#   1. Llene las filas de datos en Excel / Google Sheets
#   2. Exporte como CSV (separado por comas)
#   3. Use Archivo → Importar CSV en StructWeb3D
#   4. Las líneas que comienzan con # son ignoradas
#   5. El orden de las filas es libre (materiales, secciones,
#      nodos y elementos se resuelven automáticamente)
# ══════════════════════════════════════════════════════════════

# ── MATERIALES ─────────────────────────────────────────────────
# TYPE,     ID,  nombre,           E (kN/m²),    G (kN/m²),    nu,    rho (ton/m³)
MATERIAL,    1,  Concreto H30,     28700000,     11960000,     0.2,   2.5
MATERIAL,    2,  Acero A630-420H,  200000000,    77000000,     0.3,   7.85

# ── SECCIONES ──────────────────────────────────────────────────
# TYPE,    ID,  nombre,      A(m²),   Iz(m⁴),    Iy(m⁴),    J(m⁴),     Avy(m²),  Avz(m²),  κy,     κz
SECTION,   1,  Col 30x30,   0.09,    6.75e-4,   6.75e-4,   1.13e-4,   0.075,    0.075,    0.833,  0.833
SECTION,   2,  Viga 30x50,  0.15,    3.125e-3,  5.625e-4,  1.30e-4,   0.125,    0.075,    0.833,  0.833

# ── NODOS ──────────────────────────────────────────────────────
# TYPE, ID, X(m),  Y(m),  Z(m),  ux, uy, uz, rx, ry, rz   (1=fijo, 0=libre)
NODE,   1,  0.0,   0.0,   0.0,   1,  1,  1,  1,  1,  1
NODE,   2,  5.0,   0.0,   0.0,   1,  1,  1,  1,  1,  1
NODE,   3,  10.0,  0.0,   0.0,   1,  1,  1,  1,  1,  1
NODE,   4,  0.0,   0.0,   3.0,   0,  0,  0,  0,  0,  0
NODE,   5,  5.0,   0.0,   3.0,   0,  0,  0,  0,  0,  0
NODE,   6,  10.0,  0.0,   3.0,   0,  0,  0,  0,  0,  0
NODE,   7,  0.0,   0.0,   6.0,   0,  0,  0,  0,  0,  0
NODE,   8,  5.0,   0.0,   6.0,   0,  0,  0,  0,  0,  0
NODE,   9,  10.0,  0.0,   6.0,   0,  0,  0,  0,  0,  0

# ── ELEMENTOS ──────────────────────────────────────────────────
# TYPE,    ID, n1, n2, mat_id, sec_id
ELEMENT,   1,  1,  4,  1,      1
ELEMENT,   2,  2,  5,  1,      1
ELEMENT,   3,  3,  6,  1,      1
ELEMENT,   4,  4,  7,  1,      1
ELEMENT,   5,  5,  8,  1,      1
ELEMENT,   6,  6,  9,  1,      1
ELEMENT,   7,  4,  5,  1,      2
ELEMENT,   8,  5,  6,  1,      2
ELEMENT,   9,  7,  8,  1,      2
ELEMENT,  10,  8,  9,  1,      2

# ── DIAFRAGMAS (opcional) ──────────────────────────────────────
# TYPE,       ID, Z(m), nodos(sep;), cm_x, cm_y, masa(ton), Icm(ton·m²), ex(m), ey(m)
# DIAPHRAGM,  1,  3.0,  4;5;6,       5.0,  0.0,  50.0,       120.0,       0.05,  0.05
# DIAPHRAGM,  2,  6.0,  7;8;9,       5.0,  0.0,  50.0,       120.0,       0.05,  0.05
`;
  }
}
