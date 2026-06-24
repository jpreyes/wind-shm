// ──────────────────────────────────────────────────────────────────────────────
// io/registry.js — REGISTRO de formatos de intercambio (#74, G18)
//
// API general y extensible para importar/exportar el modelo a CUALQUIER motor.  Un
// formato es un adaptador  { id, name, ext, caps, write(neutral)→string, read(text)→neutral }
// que sólo conoce el MODELO NEUTRO (`neutral.js`).  Agregar un motor = `registerFormat({…})`;
// no hay que tocar el `Model`, el solver ni la UI.  La UI y la API pública leen este
// registro para poblar menús y resolver el adaptador por id.
//
//   registerFormat(def)            → registra/sobre-escribe un adaptador
//   getFormat(id) / listFormats()  → consulta
//   exportModel(model, id)         → { text, ext, warnings }
//   importModel(text, id)          → { model, warnings }
// ──────────────────────────────────────────────────────────────────────────────
import { modelToNeutral, neutralToModel } from './neutral.js?v=191';

const _formats = new Map();

/**
 * Registra un adaptador de formato.
 * @param {object} def
 *   id    {string}  identificador único ('vector', 'abaqus', 'sap2000', …)
 *   name  {string}  nombre legible para la UI
 *   ext   {string}  extensión por defecto sin punto ('dat', 'inp', 's2k', …)
 *   caps  {object}  { write:bool, read:bool } capacidades
 *   write {(neutral)=>string}   serializa el modelo neutro a texto del formato
 *   read  {(text)=>neutral}     parsea texto del formato a modelo neutro
 */
export function registerFormat(def) {
  if (!def || !def.id) throw new Error('registerFormat: falta id');
  _formats.set(def.id, {
    id: def.id, name: def.name || def.id, ext: def.ext || 'txt',
    caps: { write: !!def.write, read: !!def.read, ...(def.caps || {}) },
    write: def.write, read: def.read,
  });
  return def.id;
}

export function getFormat(id) { return _formats.get(id) || null; }

/** Lista de adaptadores registrados (sin las funciones) para poblar la UI. */
export function listFormats() {
  return [..._formats.values()].map(f => ({ id: f.id, name: f.name, ext: f.ext, caps: f.caps }));
}

/**
 * Exporta un `Model` de PÓRTICO al formato `id`.
 * @returns {{ text:string, ext:string, warnings:string[] }}
 */
export function exportModel(model, id) {
  const f = getFormat(id);
  if (!f) throw new Error(`Formato desconocido: ${id}`);
  if (!f.write) throw new Error(`El formato «${f.name}» no soporta exportar`);
  const neutral = modelToNeutral(model);
  const text = f.write(neutral);
  return { text, ext: f.ext, warnings: [...(neutral.meta?.warnings || []), ...(neutral.meta?.exportWarnings || [])] };
}

/**
 * Importa texto del formato `id` a un `Model` nuevo de PÓRTICO.
 * @returns {{ model:Model, warnings:string[] }}
 */
export function importModel(text, id) {
  const f = getFormat(id);
  if (!f) throw new Error(`Formato desconocido: ${id}`);
  if (!f.read) throw new Error(`El formato «${f.name}» no soporta importar`);
  const neutral = f.read(text);
  const model = neutralToModel(neutral);
  return { model, warnings: neutral.meta?.warnings || [] };
}
