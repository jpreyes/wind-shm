// ──────────────────────────────────────────────────────────────────────────────
// registry.js — Registro de CÓDIGOS DE DISEÑO conectables.
//
// Cada código (AISC 360, Eurocódigo 3, ACI 318, NCh1198…) se registra con una
// interfaz uniforme y puede consultarse por id o por familia de material. La API
// pública permite registrar códigos NUEVOS de terceros sin tocar el núcleo.
//
// Interfaz de un código:
//   {
//     id:     'AISC360-16:LRFD',          // identificador único
//     family: 'steel',                    // familia de material que cubre
//     label:  'AISC 360-16 (LRFD)',       // etiqueta legible
//     check({ demands, mat, sec, member, options }) -> {
//        checks: { axial, shear, flexion, interaccion, ... },   // cada uno {demanda,capacidad,ratio,formula,...}
//        ratioMax, gobierna, estado, metodo
//     }
//   }
// ──────────────────────────────────────────────────────────────────────────────

const _codes = new Map();

export function registerDesignCode(code) {
  if (!code || !code.id) throw new Error('El código de diseño necesita un id.');
  _codes.set(code.id, code);
  return code;
}

export function getDesignCode(id) { return _codes.get(id) || null; }

export function listDesignCodes(family) {
  const all = [..._codes.values()];
  return family ? all.filter(c => c.family === family) : all;
}

// Código por defecto por familia (el primero registrado de esa familia, salvo que
// se haya fijado uno con setDefaultCode).
const _defaults = new Map();
export function setDefaultCode(family, id) { _defaults.set(family, id); }
export function defaultCodeFor(family) {
  if (_defaults.has(family)) return getDesignCode(_defaults.get(family));
  const list = listDesignCodes(family);
  return list[0] || null;
}

export function clearDesignCodes() { _codes.clear(); _defaults.clear(); }
