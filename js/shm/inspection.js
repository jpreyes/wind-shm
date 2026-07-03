// ─────────────────────────────────────────────────────────────────────────────
// inspection.js — micro-sistema de inspección estructural (Frente · R-32).
//
// Port a JS del scoring determinista de structapp-base (`inspection_scoring.py`):
// puntaje por daño y por inspección normalizado 0–100, con pesos documentados
// (severidad · causa · tipo · extensión). 100% en el navegador (sin Python/servidor;
// la 2ª opinión por LLM del original queda para cuando haya backend, R-10).
//
// + catálogos de tipos/causas/severidades (de structapp-base, ampliados a eólica)
// + almacén en localStorage por estructura (inspecciones, daños, ensayos, docs).
// Módulo ES puro → verificable en Node.
// ─────────────────────────────────────────────────────────────────────────────

// ── Catálogos (de structapp-base; los 4 primeros tipos/última causa son de eólica) ──
export const SEVERITIES = ['Leve', 'Media', 'Alta', 'Muy Alta'];
export const CONDITIONS = [
  { key: 'operativa', label: 'Operativa' },
  { key: 'observacion', label: 'Observación' },
  { key: 'critica', label: 'Crítica' },
];
export const DAMAGE_TYPES = [
  'Aflojamiento o pérdida de pernos de brida',
  'Fisura en cordón de soldadura de base',
  'Fisura en grout / interfaz fuste–fundación',
  'Erosión o socavación en fundaciones',
  'Fisura longitudinal en vigas',
  'Fisura diagonal por cortante',
  'Fisuración en nodos',
  'Desprendimiento de recubrimiento',
  'Corrosión de armaduras expuestas',
  'Pandeo local en perfiles',
  'Deformación excesiva de losas',
  'Asentamiento diferencial',
  'Delaminación en elementos de hormigón',
  'Aplastamiento en apoyos',
  'Grieta vertical en muros',
  'Humedad capilar y eflorescencias',
  'Fallo o fisura en soldaduras',
  'Fatiga en elementos metálicos',
  'Rotura o pérdida de arriostramientos',
  'Pérdida de sección por corrosión generalizada',
  'Desalineación o desplazamiento de marcos',
  'Impacto localizado en elementos',
];
export const DAMAGE_CAUSES = [
  'Pretensado insuficiente de pernos',
  'Curado inadecuado del hormigón',
  'Asentamiento del terreno',
  'Socavación por agua subterránea',
  'Fatiga por cargas cíclicas',
  'Sobrecarga gravitacional sostenida',
  'Sobrecarga accidental o impacto',
  'Deficiencias de diseño estructural',
  'Detalles constructivos deficientes',
  'Corrosión inducida por cloruros',
  'Carbonatación avanzada',
  'Humedad permanente o fugas',
  'Movimiento sísmico recurrente',
  'Vibraciones por maquinaria',
  'Cambio de uso no evaluado',
  'Incendio o acción térmica',
  'Impacto vehicular',
  'Choque de equipos móviles',
  'Errores de mantenimiento',
  'Corrosión galvánica',
];

// ── Pesos del modelo determinista (idénticos a inspection_scoring.py) ─────────
const W = {
  severity: { 'Leve': 1.0, 'Media': 2.0, 'Alta': 3.0, 'Muy Alta': 4.0 },
  cause: { estructural: 1.5, deformacion: 1.3, corrosion: 1.4, filtracion: 1.2, electrico: 1.2, estetico: 1.0, mantenimiento: 1.1 },
  type: { fisura: 1.3, desprendimiento: 1.4, asentamiento: 1.5, corrosion: 1.4, desgaste: 1.1, golpes: 1.0, otro: 1.0 },
};
const maxOf = (o) => Math.max(...Object.values(o));
const MAX_RAW_DAMAGE = maxOf(W.severity) * maxOf(W.cause) * maxOf(W.type) * 2;   // = 18

// quita acentos y baja a minúsculas → para que el match por substring funcione
// (el .py original comparaba sin normalizar, así que las claves casi no pegaban).
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const factor = (table, value) => { const v = norm(value); for (const k in table) if (v.includes(k)) return table[k]; return 1.0; };

// Factor de extensión: número o "35%" → 0..1 (clamp); texto no numérico → 0.
function extentFactor(value) {
  if (value == null) return 0;
  const n = parseFloat(String(value).replace('%', '').trim());
  if (!isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n / 100));
}

// Puntaje CRUDO de un daño = sev · causa · tipo · (1 + extensión).
function rawDamage(d) {
  return (W.severity[d.severity] ?? 1.0) * factor(W.cause, d.damage_cause) * factor(W.type, d.damage_type) * (1 + extentFactor(d.extent));
}
const round2 = (x) => Math.round(x * 100) / 100;

/** Puntaje de un daño normalizado 0–100 (más alto = más crítico). */
export function scoreDamage(d) {
  return Math.min(100, round2((rawDamage(d) / MAX_RAW_DAMAGE) * 100));
}

/**
 * Puntaje de una inspección 0–100 = promedio de los daños × multiplicador por
 * cantidad (1 + min(0.5, n/10)). *(En el .py el multiplicador se cancelaba por un
 * error de normalización; aquí se aplica el comportamiento DOCUMENTADO: más daños →
 * peor, hasta +50%.)* Sin daños = 0.
 */
export function inspectionScore(damages) {
  const list = damages || [];
  if (!list.length) return 0;
  const mean = list.reduce((a, d) => a + scoreDamage(d), 0) / list.length;
  const countMult = 1 + Math.min(0.5, list.length / 10);
  return Math.min(100, round2(mean * countMult));
}

/** Tramo orientativo (0-30 bajo · 30-60 medio · 60-100 alto). */
export function scoreBand(s) {
  return s >= 60 ? { label: 'Alto', cls: 'critica' } : s >= 30 ? { label: 'Medio', cls: 'observacion' } : { label: 'Bajo', cls: 'operativa' };
}
/** Condición sugerida desde el puntaje (editable por el inspector). */
export function conditionFromScore(s) { return s >= 60 ? 'critica' : s >= 30 ? 'observacion' : 'operativa'; }
export const conditionLabel = (k) => (CONDITIONS.find(c => c.key === k) || CONDITIONS[0]).label;

// ── Almacén local (localStorage) por estructura ──────────────────────────────
const KEY = 'rewind.inspections.v1';
const loadAll = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
// R-40c: al llenarse el localStorage, avisar (evento) en vez de fallar en silencio.
const saveAll = (o) => {
  try { localStorage.setItem(KEY, JSON.stringify(o)); return true; }
  catch (e) {
    console.warn('[insp] no se pudo guardar', e);
    const quota = e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
    if (quota && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('rewind-storage-full', { detail: { key: KEY } }));
    return false;
  }
};
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** Mapa completo {structId: [inspecciones]} con UN solo parse (R-40d: rollup sin N parses). */
export function getAll() { return loadAll(); }

/** Inspecciones de una estructura, ordenadas por fecha desc. */
export function getInspections(structId) {
  return (loadAll()[structId] || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// ── R-40b: marca de «sembrada» por estructura (borrar la última NO re-siembra) ──
const SEED_KEY = 'rewind.inspSeeded.v1';
const loadSeeded = () => { try { return new Set(JSON.parse(localStorage.getItem(SEED_KEY)) || []); } catch { return new Set(); } };
export function wasSeeded(id) { return loadSeeded().has(id); }
export function markSeeded(id) { const s = loadSeeded(); s.add(id); try { localStorage.setItem(SEED_KEY, JSON.stringify([...s])); } catch { /* cuota: no crítico */ } }
export function setInspections(structId, list) { const a = loadAll(); a[structId] = list; saveAll(a); }

/** Crea (y persiste) una inspección nueva para la estructura. */
export function addInspection(structId, fields = {}) {
  const list = loadAll()[structId] || [];
  const insp = {
    id: uid(),
    date: fields.date || new Date().toISOString().slice(0, 10),
    inspector: fields.inspector || 'Inspector',
    location: fields.location || '',
    summary: fields.summary || '',
    condition: fields.condition || 'operativa',
    damages: [], tests: [], documents: [], photos: [], workOrders: [],
    nextDate: fields.nextDate || addDays(fields.date || new Date().toISOString().slice(0, 10), 180),
    created: Date.now(),
  };
  list.push(insp); setInspections(structId, list);
  return insp;
}
export function updateInspection(structId, insp) {
  const list = (loadAll()[structId] || []).map(i => i.id === insp.id ? insp : i);
  setInspections(structId, list);
}
export function removeInspection(structId, inspId) {
  setInspections(structId, (loadAll()[structId] || []).filter(i => i.id !== inspId));
}

// ── Respaldo / restauración (portabilidad sin backend; persistencia real → R-10) ──
export function exportJSON() { return JSON.stringify(loadAll(), null, 2); }
/** Importa un JSON de inspecciones. replace=false fusiona por estructura. Devuelve nº de estructuras. */
export function importJSON(text, replace = false) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Formato de respaldo inválido.');
  const cur = replace ? {} : loadAll();
  let n = 0;
  for (const k in data) if (Array.isArray(data[k])) { cur[k] = data[k]; n++; }
  saveAll(cur); return n;
}

// ── Órdenes de trabajo + calendario (vencimientos) ───────────────────────────
export const WO_STATUS = ['abierto', 'en curso', 'cerrado'];
export const WO_PRIORITY = ['baja', 'media', 'alta'];
export const addDays = (iso, n) => new Date((Date.parse(iso) || Date.now()) + n * 864e5).toISOString().slice(0, 10);
/** Estado de un vencimiento: {overdue, soon} (soon = ≤30 días, no vencido). */
export function dueState(iso, soonDays = 30) {
  if (!iso) return { overdue: false, soon: false };
  const d = Math.round((Date.parse(iso) - Date.now()) / 864e5);
  return { overdue: d < 0, soon: d >= 0 && d <= soonDays, days: d };
}
/** Prioridad sugerida de OT a partir de la severidad del hallazgo. */
export const priorityFromSeverity = (sev) => (sev === 'Muy Alta' || sev === 'Alta') ? 'alta' : sev === 'Media' ? 'media' : 'baja';

// ── Ensayos genéricos: el TIPO determina si es ensayo no destructivo (NDT) ────
const NDT_KEYS = ['ultrason', 'radiograf', 'magnetic', 'penetrant', 'esclerom', 'termograf', 'acustic', 'eddy', 'foucault', 'georradar', 'rebote', 'rebound', 'impact', 'potencial', 'resistivid', 'pull-off', 'pull off', 'pacometr', 'carbonatac'];
/** Clasifica un ensayo por su tipo: {ndt, label}. NDT = no destructivo. */
export function classifyTest(type) {
  const t = norm(type);
  const ndt = NDT_KEYS.some(k => t.includes(k));
  return { ndt, label: ndt ? 'NDT' : 'Ensayo' };
}

// ── Foto → thumbnail (data URI) reescalado, para no inflar localStorage ───────
export async function imageToThumb(file, maxW = 760, quality = 0.72) {
  // R-40f: createImageBitmap con corrección de orientación EXIF (las fotos de
  // celular suelen venir rotadas). Fallback al camino FileReader+Image si no está.
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, maxW / bmp.width);
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h); bmp.close?.();
      return c.toDataURL('image/jpeg', quality);
    } catch { /* navegador sin soporte de opciones → fallback */ }
  }
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

// ── Autoverificación (node js/shm/inspection.js) ──────────────────────────────
if (typeof process !== 'undefined' && import.meta.url.endsWith((process.argv?.[1] || '').replace(/\\/g, '/'))) {
  const d1 = { severity: 'Muy Alta', damage_cause: 'Deficiencias de diseño estructural', damage_type: 'Asentamiento diferencial', extent: '100%' };
  const d2 = { severity: 'Leve', damage_cause: 'Errores de mantenimiento', damage_type: 'Humedad capilar y eflorescencias', extent: '5%' };
  console.log('daño crítico:', scoreDamage(d1), '(esperado 100)');
  console.log('daño leve   :', scoreDamage(d2));
  console.log('inspección 1 daño crítico:', inspectionScore([d1]));
  console.log('inspección 2 daños       :', inspectionScore([d1, d2]));
  console.log('inspección vacía         :', inspectionScore([]));
  const ok = scoreDamage(d1) === 100 && scoreDamage(d2) < 30 && inspectionScore([]) === 0;
  console.log(ok ? 'OK ✓' : 'FALLA ✗');
}
