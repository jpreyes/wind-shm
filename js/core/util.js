// ─────────────────────────────────────────────────────────────────────────────
// util.js — utilidades compartidas mínimas de ReWind.
//
// `esc`  — escapa texto para insertarlo con seguridad en HTML (contenido Y
//          atributos): cubre & < > " '. Único punto de escape para todos los
//          sinks de `innerHTML` con datos de usuario o importados (R-40a).
// `safeUrl` — filtra URLs para contextos CSS `url(...)` / `src`: sólo admite
//          data:image, blob: y http(s); cualquier otra cosa → '' (evita romper
//          el `url('...')` o inyectar `javascript:` desde un JSON importado).
// ─────────────────────────────────────────────────────────────────────────────

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENT[c]);

export const safeUrl = (u) => (typeof u === 'string' && /^(data:image\/|blob:|https?:)/i.test(u) ? u : '');
