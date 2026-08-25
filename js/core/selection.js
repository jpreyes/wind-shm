// ─────────────────────────────────────────────────────────────────────────────
// core/selection.js — store de selección compartido (torre `current`) con pub/sub.
//
// Groundwork del refactor B2: los workspaces extraídos del módulo-dios leen la torre
// seleccionada de acá, en vez de una variable del closure de shm_mode. `select()` en
// shm_mode escribe acá (espejo); los workspaces se suscriben para reaccionar a cambios
// de selección (p.ej. resetear estado local) sin acoplarse a shm_mode.
// ─────────────────────────────────────────────────────────────────────────────
let _current = null;
const _subs = new Set();

export function getCurrent() { return _current; }

export function setCurrent(s) {
  const v = s || null;
  if (v === _current) return;
  _current = v;
  for (const fn of _subs) { try { fn(v); } catch { /* */ } }
}

// subscribe(fn) → fn(current) en cada cambio. Devuelve una función para desuscribir.
export function subscribe(fn) { _subs.add(fn); return () => _subs.delete(fn); }
